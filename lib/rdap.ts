/**
 * Domain registration data via RDAP (the official successor of WHOIS).
 *
 * The RDAP server for each TLD comes from the IANA bootstrap file, so we only
 * ever call registry servers that IANA lists, over HTTPS. User input only
 * picks the domain name in the path, never the host we connect to.
 */

export type RDAPResult = {
  expires_at: string | null;
  registrar: string | null;
  // Short, fixed messages only. Raw errors are never stored.
  error: string | null;
};

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;

let bootstrap: { at: number; map: Map<string, string> } | null = null;

/**
 * Simplified: the last two labels (sub.example.com -> example.com).
 * Second-level registries such as .co.th are not handled.
 */
export function registrableDomain(host: string) {
  return host.split('.').slice(-2).join('.');
}

async function readJSON(res: Response) {
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('too large');
  return JSON.parse(text);
}

async function rdapBase(tld: string) {
  if (!bootstrap || Date.now() - bootstrap.at > BOOTSTRAP_TTL_MS) {
    const res = await fetch(BOOTSTRAP_URL, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('bootstrap');
    const data = (await readJSON(res)) as { services: [string[], string[]][] };
    const map = new Map<string, string>();
    for (const [tlds, urls] of data.services) {
      const https = urls.find((u) => u.startsWith('https://'));
      if (!https) continue;
      for (const t of tlds) map.set(t.toLowerCase(), https.endsWith('/') ? https : `${https}/`);
    }
    bootstrap = { at: Date.now(), map };
  }
  return bootstrap.map.get(tld) ?? null;
}

type Entity = { roles?: string[]; vcardArray?: [string, [string, unknown, string, unknown][]] };

function registrarName(entities: Entity[] | undefined) {
  const registrar = entities?.find((e) => e.roles?.includes('registrar'));
  const fn = registrar?.vcardArray?.[1]?.find((field) => field[0] === 'fn');
  return typeof fn?.[3] === 'string' ? fn[3] : null;
}

export async function checkRDAP(host: string): Promise<RDAPResult> {
  const empty = { expires_at: null, registrar: null };
  const domain = registrableDomain(host);
  const tld = domain.split('.').pop() ?? '';
  try {
    const base = await rdapBase(tld);
    if (!base) return { ...empty, error: 'RDAP not available for this TLD' };

    const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
      headers: { accept: 'application/rdap+json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { ...empty, error: 'Domain not found in registry' };
    if (!res.ok) return { ...empty, error: `RDAP HTTP ${res.status}` };

    const data = (await readJSON(res)) as {
      events?: { eventAction: string; eventDate: string }[];
      entities?: Entity[];
    };
    const expiration = data.events?.find((e) => e.eventAction === 'expiration')?.eventDate;
    const expires = expiration ? new Date(expiration) : null;
    return {
      expires_at: expires && !isNaN(expires.getTime()) ? expires.toISOString() : null,
      registrar: registrarName(data.entities),
      error: expires ? null : 'No expiration date in RDAP',
    };
  } catch {
    return { ...empty, error: 'RDAP lookup failed' };
  }
}
