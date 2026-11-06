import { lookup } from 'node:dns/promises';
import { connect, type PeerCertificate } from 'node:tls';
import { publicIP, validHostname } from '@/lib/audit';

export type SSLResult = {
  expires_at: string | null;
  issuer: string | null;
  days_left: number | null;
  // Short, fixed messages only. Raw errors are never stored.
  error: string | null;
};

const TIMEOUT_MS = 6000;

function issuerName(cert: PeerCertificate) {
  const issuer = cert.issuer as Record<string, string | string[]> | undefined;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return pick(issuer?.O) || pick(issuer?.CN) || null;
}

function safeTLSError(code: string | undefined) {
  if (!code) return 'TLS error';
  if (code === 'CERT_HAS_EXPIRED') return 'Certificate expired';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'Certificate does not match domain';
  if (/SELF_SIGNED/.test(code)) return 'Self-signed certificate';
  if (/UNABLE_TO_(GET|VERIFY)/.test(code)) return 'Untrusted certificate chain';
  return 'Certificate not trusted';
}

/**
 * Reads the certificate on port 443. SSRF guard: the hostname is validated,
 * every resolved address must be public, and we connect to the address we
 * vetted (not a second lookup), so DNS rebinding cannot redirect this probe.
 * Only the TLS handshake happens; no HTTP request is sent.
 */
export async function checkSSL(host: string): Promise<SSLResult> {
  const empty = { expires_at: null, issuer: null, days_left: null };
  if (!validHostname(host)) return { ...empty, error: 'Invalid hostname' };

  let address: string;
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.length === 0 || !resolved.every((r) => publicIP(r.address))) {
      return { ...empty, error: 'Unsafe or unsupported destination' };
    }
    address = resolved[0].address;
  } catch {
    return { ...empty, error: 'DNS error' };
  }

  return new Promise<SSLResult>((resolve) => {
    let done = false;
    const finish = (result: SSLResult) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    const socket = connect({
      host: address,
      port: 443,
      servername: host,
      // Read the certificate even when it is invalid, then report why.
      rejectUnauthorized: false,
      timeout: TIMEOUT_MS,
    });

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) {
        finish({ ...empty, error: 'No certificate' });
        return;
      }
      const expires = new Date(cert.valid_to);
      const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86400000);
      const authError = socket.authorized
        ? null
        : safeTLSError(String(socket.authorizationError ?? ''));
      finish({
        expires_at: expires.toISOString(),
        issuer: issuerName(cert),
        days_left: daysLeft,
        error: authError,
      });
    });
    socket.once('timeout', () => finish({ ...empty, error: 'Timeout' }));
    socket.once('error', () => finish({ ...empty, error: 'TLS error' }));
  });
}
