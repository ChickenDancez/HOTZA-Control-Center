import { resolveNs } from 'node:dns/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkSSL } from '@/lib/ssl';
import { checkRDAP, registrableDomain } from '@/lib/rdap';
import { escapeHTML, notifyTelegram } from '@/lib/alerts';

export type Level = 'ok' | 'warn' | 'bad';

export type WatchRow = {
  id: string;
  hostname: string;
  ssl_level: Level | null;
  expiry_level: Level | null;
  ns_records: string[] | null;
  domain_checked_at: string | null;
};

export const WATCH_COLUMNS = 'ssl_level,expiry_level,ns_records,domain_checked_at';

const SSL_WARN_DAYS = 14;
const DOMAIN_WARN_DAYS = 30;
// Registries rate-limit RDAP. Expiry dates change rarely, so twice a day is plenty.
const RDAP_INTERVAL_MS = 12 * 60 * 60 * 1000;

function daysUntil(iso: string) {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
}

// Network hiccups say nothing about the certificate: keep the previous level.
const TRANSIENT_SSL_ERRORS = ['Timeout', 'TLS error', 'DNS error'];

function sslLevel(expires: string | null, error: string | null): Level | null {
  if (error && !expires && TRANSIENT_SSL_ERRORS.includes(error)) return null;
  if (error || !expires) return 'bad';
  const days = daysUntil(expires);
  if (days < 0) return 'bad';
  return days <= SSL_WARN_DAYS ? 'warn' : 'ok';
}

function expiryLevel(expires: string | null): Level | null {
  if (!expires) return null; // unknown (e.g. TLD without RDAP): stay silent
  const days = daysUntil(expires);
  if (days < 0) return 'bad';
  return days <= DOMAIN_WARN_DAYS ? 'warn' : 'ok';
}

async function nameservers(host: string) {
  try {
    const ns = await resolveNs(registrableDomain(host));
    return ns.map((n) => n.toLowerCase().replace(/\.$/, '')).sort();
  } catch {
    return null; // lookup failed: never treat as "NS changed"
  }
}

/** Alert on a level change. A first reading alerts only when it is not ok. */
function levelChanged(prev: Level | null, next: Level | null) {
  if (!next || prev === next) return false;
  return prev !== null || next !== 'ok';
}

const ICON: Record<Level, string> = { ok: '🟢', warn: '🟡', bad: '🔴' };

/**
 * SSL certificate, domain registration expiry (RDAP) and nameserver watch.
 * Saves results on the domain row and sends Telegram only when something changes.
 */
export async function runWatch(db: SupabaseClient, row: WatchRow) {
  const rdapDue =
    !row.domain_checked_at ||
    Date.now() - new Date(row.domain_checked_at).getTime() > RDAP_INTERVAL_MS;

  const [ssl, rdap, ns] = await Promise.all([
    checkSSL(row.hostname),
    rdapDue ? checkRDAP(row.hostname) : Promise.resolve(null),
    nameservers(row.hostname),
  ]);

  const patch: Record<string, unknown> = {
    ssl_error: ssl.error,
    watch_checked_at: new Date().toISOString(),
  };
  if (ssl.expires_at) {
    patch.ssl_expires_at = ssl.expires_at;
    patch.ssl_issuer = ssl.issuer;
  }
  const newSSL = sslLevel(ssl.expires_at, ssl.error);
  if (newSSL) patch.ssl_level = newSSL;
  if (rdap) {
    // On a failed lookup (e.g. registry rate limit), retry in about 1 hour, not 12.
    const retryAt = rdap.error ? Date.now() - RDAP_INTERVAL_MS + 60 * 60 * 1000 : Date.now();
    patch.domain_checked_at = new Date(retryAt).toISOString();
    patch.domain_error = rdap.error;
    if (rdap.expires_at) {
      patch.domain_expires_at = rdap.expires_at;
      patch.expiry_level = expiryLevel(rdap.expires_at);
    }
    if (rdap.error === 'Domain not found in registry') {
      // Not registered any more: someone else could register it.
      patch.expiry_level = 'bad';
    }
    if (rdap.registrar) patch.registrar = rdap.registrar;
  }
  const nsChanged =
    ns !== null && row.ns_records !== null && ns.join(',') !== row.ns_records.join(',');
  if (ns !== null) patch.ns_records = ns;
  if (nsChanged) patch.ns_changed_at = new Date().toISOString();

  const { error } = await db.from('domains').update(patch).eq('id', row.id);
  if (error) {
    console.error('Could not save watch results:', error.code);
    return;
  }

  const name = escapeHTML(row.hostname);
  const at = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  const messages: string[] = [];

  if (newSSL && levelChanged(row.ssl_level, newSSL)) {
    const detail = ssl.error
      ? escapeHTML(ssl.error)
      : `หมดอายุใน ${ssl.days_left} วัน (${escapeHTML(ssl.issuer || '-')})`;
    messages.push(`${ICON[newSSL]} <b>SSL ${name}</b>\n${detail}`);
  }

  const newExpiry = (patch.expiry_level as Level | undefined) ?? null;
  if (rdap && levelChanged(row.expiry_level, newExpiry) && newExpiry) {
    const days = rdap.expires_at ? daysUntil(rdap.expires_at) : null;
    const detail =
      days === null
        ? 'ไม่พบโดเมนในทะเบียน (อาจหลุดแล้ว คนอื่นจดได้)'
        : days < 0
          ? 'โดเมนหมดอายุแล้ว'
          : `โดเมนหมดอายุใน ${days} วัน`;
    messages.push(`${ICON[newExpiry]} <b>โดเมน ${name}</b>\n${detail}`);
  }

  if (nsChanged && ns) {
    messages.push(
      `🚨 <b>Nameserver ของ ${name} เปลี่ยน</b>\n` +
        `เดิม: ${escapeHTML(row.ns_records!.join(', '))}\n` +
        `ใหม่: ${escapeHTML(ns.join(', '))}\n` +
        'ถ้าไม่ได้เปลี่ยนเอง ให้รีบเช็กบัญชี registrar ทันที',
    );
  }

  for (const m of messages) await notifyTelegram(`${m}\nเวลา: ${at}`);
}
