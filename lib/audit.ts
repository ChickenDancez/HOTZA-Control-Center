import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
export type RedirectHop = {
  from: string;
  to: string;
  status: number;
};
export type AuditResult = {
  status_code: number | null;
  final_url: string | null;
  redirects: RedirectHop[];
  issue: string | null;
  latency_ms: number;
};
const MAX_HOPS = 5;
const CHECK_BUDGET_MS = 10000;
function validHostname(host: string) {
  return (
    host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
  );
}
function publicIP(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return !(
      s === '::1' ||
      s === '::' ||
      s.startsWith('fc') ||
      s.startsWith('fd') ||
      s.startsWith('fe8') ||
      s.startsWith('fe9') ||
      s.startsWith('fea') ||
      s.startsWith('feb') ||
      s.startsWith('::ffff:')
    );
  }
  return false;
}
async function safeUrl(url: URL) {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !validHostname(url.hostname)
  )
    return false;
  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  return resolved.length > 0 && resolved.every((item) => publicIP(item.address));
}
function safeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'Timeout';
    const cause = error.cause as
      | {
          code?: string;
        }
      | undefined;
    const code = cause?.code ?? '';
    if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(code)) return 'DNS error';
    if (['ECONNREFUSED', 'ECONNRESET'].includes(code)) return 'Connection refused';
    if (/CERT|TLS|SSL|SELF_SIGNED/i.test(code)) return 'TLS error';
  }
  return 'Network error';
}
/**
 * HTTPS-only, HEAD-only. No response bodies are fetched.
 * 405/501 means HEAD is unsupported: do not claim that a browser GET failed.
 * DNS is screened before each hop. For multi-tenant use, add DNS/IP pinning
 * to close the resolver-to-fetch rebinding window (see README).
 */
export async function audit(host: string): Promise<AuditResult> {
  const started = Date.now();
  const deadline = started + CHECK_BUDGET_MS;
  const redirects: RedirectHop[] = [];
  let current = `https://${host}/`;
  let status_code: number | null = null;
  let issue: string | null = null;
  let finished = false;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 500) {
        issue = 'Timeout';
        break;
      }
      const url = new URL(current);
      if (!(await safeUrl(url))) {
        issue = 'Unsafe or unsupported destination';
        break;
      }
      const afterDNS = deadline - Date.now();
      if (afterDNS <= 500) {
        issue = 'Timeout';
        break;
      }
      const res = await fetch(url.toString(), {
        method: 'HEAD',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(afterDNS),
        headers: { 'user-agent': 'DomainHealthCheck/2.0' },
      });
      status_code = res.status;
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (hop >= MAX_HOPS) {
          issue = 'Redirect chain too long';
          break;
        }
        const location = res.headers.get('location');
        if (!location) {
          issue = 'Redirect without Location';
          break;
        }
        const next = new URL(location, url);
        if (!(await safeUrl(next))) {
          issue = 'Redirect to unsafe destination';
          break;
        }
        redirects.push({ from: current, to: next.toString(), status: res.status });
        current = next.toString();
        continue;
      }
      if (res.status === 405 || res.status === 501) {
        issue = 'HEAD not supported — browser redirect not verified';
      } else if (res.status >= 400) {
        issue = `HTTP ${res.status}`;
      }
      finished = true;
      break;
    } catch (error) {
      console.error('Audit request failed:', error);
      issue = safeError(error);
      break;
    }
  }
  if (!finished && !issue) issue = 'Redirect chain too long';
  return { status_code, final_url: current, redirects, issue, latency_ms: Date.now() - started };
}
export function auditState(result: AuditResult): 'ok' | 'issue' | null {
  if (result.status_code === 405 || result.status_code === 501) return null;
  if (result.issue === 'HEAD not supported — browser redirect not verified') return null;
  return result.issue || result.status_code === null || result.status_code >= 400 ? 'issue' : 'ok';
}
