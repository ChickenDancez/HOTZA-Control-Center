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
  method: 'HEAD' | 'GET';
  // Technical SEO hints (not downtime): temporary or chained redirects, noindex.
  seo_warning: string | null;
};
const MAX_HOPS = 5;
const CHECK_BUDGET_MS = 10000;

/**
 * Some servers answer HEAD with 405/501. When true, the same hop is retried
 * once with GET, and the response body is cancelled as soon as headers arrive:
 * page content is never read or stored. Set to false for strict HEAD-only.
 */
const GET_FALLBACK_ON_405 = true;

async function probe(url: URL, method: 'HEAD' | 'GET', timeoutMs: number) {
  const res = await fetch(url.toString(), {
    method,
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'DomainHealthCheck/2.0' },
  });
  // Never read the body. Cancel the stream so no page content is downloaded.
  await res.body?.cancel().catch(() => undefined);
  return res;
}
export function validHostname(host: string) {
  return (
    host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
  );
}
export function publicIP(ip: string) {
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
 * HTTPS-only. HEAD first; on 405/501 one GET retry (see GET_FALLBACK_ON_405).
 * Response bodies are never read. If both fail with 405/501, do not claim
 * that a browser GET failed.
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
  let method: 'HEAD' | 'GET' = 'HEAD';
  let noindex = false;
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
      let res = await probe(url, 'HEAD', afterDNS);
      if (GET_FALLBACK_ON_405 && (res.status === 405 || res.status === 501)) {
        const afterHead = deadline - Date.now();
        if (afterHead <= 500) {
          issue = 'Timeout';
          break;
        }
        res = await probe(url, 'GET', afterHead);
        method = 'GET';
      }
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
          // Record where it tried to go (never fetched), so the dashboard shows it.
          redirects.push({ from: current, to: next.toString(), status: res.status });
          current = next.toString();
          issue =
            next.protocol === 'http:'
              ? 'Redirect to insecure HTTP (not https)'
              : 'Redirect to unsafe destination';
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
      const robots = res.headers.get('x-robots-tag') ?? '';
      noindex = /noindex/i.test(robots);
      finished = true;
      break;
    } catch (error) {
      console.error('Audit request failed:', error);
      issue = safeError(error);
      break;
    }
  }
  if (!finished && !issue) issue = 'Redirect chain too long';
  return {
    seo_warning: seoWarning(redirects, noindex),
    status_code,
    final_url: current,
    redirects,
    issue,
    latency_ms: Date.now() - started,
    method,
  };
}
function seoWarning(redirects: RedirectHop[], noindex: boolean) {
  const notes: string[] = [];
  const temporary = redirects.filter(
    (r) => r.status === 302 || r.status === 303 || r.status === 307,
  );
  if (temporary.length) notes.push(`Temporary redirect (${temporary[0].status}): use 301`);
  if (redirects.length > 1)
    notes.push(`Redirect chain: ${redirects.length} hops, point straight to the final URL`);
  if (noindex) notes.push('X-Robots-Tag: noindex (Google will drop this page)');
  return notes.length ? notes.join(' · ') : null;
}
export function auditState(result: AuditResult): 'ok' | 'issue' | null {
  if (result.status_code === 405 || result.status_code === 501) return null;
  if (result.issue === 'HEAD not supported — browser redirect not verified') return null;
  return result.issue || result.status_code === null || result.status_code >= 400 ? 'issue' : 'ok';
}
