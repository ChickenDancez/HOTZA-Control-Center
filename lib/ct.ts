import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { escapeHTML, notifyTelegram } from '@/lib/alerts';
import { registrableDomain } from '@/lib/rdap';

/**
 * Lookalike-domain watch via Certificate Transparency (crt.sh).
 *
 * Every public HTTPS certificate is logged. We search the logs for names that
 * contain our brand keyword (e.g. "hotza888") but are not one of our own
 * domains. We only read crt.sh's JSON API: the lookalike sites themselves are
 * never visited.
 *
 * crt.sh is free but slow and often overloaded. Its website no longer answers
 * "%keyword%" searches (502), so we first ask crt.sh's public read-only
 * database (guest account, documented by crt.sh) and only fall back to the
 * website. A response that does not even contain our own domains is treated
 * as a failed scan, never as "no lookalikes".
 */

const DB_TIMEOUT_MS = 45000;
const CRT_TIMEOUT_MS = 30000;
const MAX_DB_ROWS = 5000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NEW_PER_SCAN = 100;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export type CTScanResult = {
  ok: boolean;
  error: string | null;
  found: string[]; // names seen for the first time in this scan
};

/** "hotza888.pro" -> "hotza888". Keywords shorter than 5 chars are too noisy. */
export function brandKeywords(hostnames: string[]) {
  const words = hostnames.map((h) => registrableDomain(h).split('.')[0]);
  return [...new Set(words)].filter((w) => w.length >= 5 && /^[a-z0-9-]+$/.test(w));
}

function isOwn(name: string, ownDomains: string[]) {
  return ownDomains.some((d) => name === d || name.endsWith(`.${d}`));
}

/** Cleans raw certificate names and keeps those that contain the keyword. */
function collectNames(values: string[], keyword: string) {
  const names = new Set<string>();
  for (const value of values) {
    for (const raw of String(value ?? '').split('\n')) {
      const name = raw
        .trim()
        .toLowerCase()
        .replace(/^\*\./, '')
        .replace(/^www\./, '');
      if (HOST_RE.test(name) && name.includes(keyword)) names.add(name);
    }
  }
  return names;
}

/**
 * crt.sh public database (host crt.sh, user guest, database certwatch).
 * Full-text prefix search finds names whose labels start with the keyword
 * (hotza888.pro, hotza888game.com, my-hotza888.net). Read-only, parameterised.
 */
async function queryCrtShDb(keyword: string): Promise<Set<string> | null> {
  const client = new Client({
    host: 'crt.sh',
    port: 5432,
    user: 'guest',
    database: 'certwatch',
    connectionTimeoutMillis: 15000,
    statement_timeout: DB_TIMEOUT_MS,
    query_timeout: DB_TIMEOUT_MS + 5000,
    application_name: 'DomainHealthCheck',
  });
  // An idle-connection error must not crash the function.
  client.on('error', () => {});
  try {
    await client.connect();
    const tsquery = /^[a-z0-9]+$/.test(keyword)
      ? "to_tsquery('certwatch', $1 || ':*')"
      : "plainto_tsquery('certwatch', $1)";
    const { rows } = await client.query<{ name_value: string }>(
      `SELECT DISTINCT cai.name_value
         FROM certificate_and_identities cai
        WHERE ${tsquery} @@ identities(cai.certificate)
          AND cai.name_value ILIKE ('%' || $1 || '%')
          AND x509_notAfter(cai.certificate) > now() AT TIME ZONE 'UTC'
        LIMIT ${MAX_DB_ROWS}`,
      [keyword],
    );
    return collectNames(
      rows.map((r) => r.name_value),
      keyword,
    );
  } catch (err) {
    console.error('crt.sh database query failed:', (err as { code?: string }).code ?? 'unknown');
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/** crt.sh website JSON API: kept as a fallback only. */
async function queryCrtShWeb(keyword: string): Promise<Set<string> | null> {
  const url = `https://crt.sh/?q=${encodeURIComponent(`%${keyword}%`)}&output=json&exclude=expired&deduplicate=Y`;
  try {
    const res = await fetch(url, {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(CRT_TIMEOUT_MS),
      headers: { 'user-agent': 'DomainHealthCheck/2.0', accept: 'application/json' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_BYTES) return null;
    const rows = JSON.parse(text) as { name_value?: string }[];
    if (!Array.isArray(rows)) return null;
    return collectNames(
      rows.map((r) => String(r.name_value ?? '')),
      keyword,
    );
  } catch {
    return null;
  }
}

async function queryCrtSh(keyword: string, ownDomains: string[]) {
  const trustworthy = (names: Set<string> | null) =>
    names !== null && [...names].some((n) => isOwn(n, ownDomains));
  const fromDb = await queryCrtShDb(keyword);
  if (trustworthy(fromDb)) return fromDb;
  const fromWeb = await queryCrtShWeb(keyword);
  if (trustworthy(fromWeb)) return fromWeb;
  return null;
}

/**
 * Scans for lookalikes of one owner's domains, records new ones, creates an
 * incident for each and sends one Telegram summary. Works with the user's own
 * client (RLS) or the cron client.
 */
export async function scanLookalikes(
  db: SupabaseClient,
  ownerId: string,
  ownHostnames: string[],
): Promise<CTScanResult> {
  const ownDomains = [...new Set(ownHostnames.map(registrableDomain))];
  const keywords = brandKeywords(ownHostnames);
  if (keywords.length === 0) return { ok: false, error: 'No brand keyword', found: [] };

  const candidates = new Set<string>();
  for (const keyword of keywords) {
    // Sanity check inside: our own certificates must show up, otherwise the answer is unreliable.
    const names = await queryCrtSh(keyword, ownDomains);
    if (!names) {
      await saveState(db, ownerId, 'crt.sh unavailable, will retry', null);
      return { ok: false, error: 'crt.sh unavailable, will retry', found: [] };
    }
    for (const n of names) if (!isOwn(n, ownDomains)) candidates.add(n);
  }

  const list = [...candidates].sort().slice(0, MAX_NEW_PER_SCAN * 5);
  let found: string[] = [];
  if (list.length) {
    // Unique (owner_id, hostname): only rows that are really new come back.
    const { data, error } = await db
      .from('lookalikes')
      .upsert(
        list.map((hostname) => ({ owner_id: ownerId, hostname })),
        { onConflict: 'owner_id,hostname', ignoreDuplicates: true },
      )
      .select('hostname');
    if (error) {
      console.error('Could not save lookalikes:', error.code);
      await saveState(db, ownerId, 'Could not save results', null);
      return { ok: false, error: 'Could not save results', found: [] };
    }
    found = (data ?? []).map((r) => r.hostname as string).slice(0, MAX_NEW_PER_SCAN);
  }

  if (found.length) {
    const { error } = await db.from('incidents').insert(
      found.map((name) => ({
        owner_id: ownerId,
        title: `เว็บชื่อคล้าย: ${name}`,
        kind: 'impersonation',
        severity: 'review',
        // Link to the certificate record, not the suspicious site itself.
        reference_url: `https://crt.sh/?q=${encodeURIComponent(name)}`,
        notes:
          'พบใบรับรอง SSL ของชื่อนี้ในทะเบียนสาธารณะ (Certificate Transparency) ' +
          'ระบบยังไม่ได้เปิดเว็บนี้ ตรวจสอบเองก่อนแจ้ง และอย่ากรอกข้อมูลใด ๆ ในเว็บต้องสงสัย',
      })),
    );
    if (error) console.error('Could not create lookalike incidents:', error.code);

    const shown = found.slice(0, 15).map((n) => `• ${escapeHTML(n)}`);
    const more = found.length > 15 ? `\n…และอีก ${found.length - 15} รายการ` : '';
    await notifyTelegram(
      `🕵️ <b>พบเว็บชื่อคล้ายใหม่ ${found.length} รายการ</b>\n${shown.join('\n')}${more}\n` +
        'ดูรายละเอียดในแดชบอร์ด หน้าเว็บสวมรอย',
    );
  }

  await saveState(db, ownerId, null, found.length);
  return { ok: true, error: null, found };
}

async function saveState(
  db: SupabaseClient,
  ownerId: string,
  lastError: string | null,
  lastFound: number | null,
) {
  const patch: Record<string, unknown> = {
    owner_id: ownerId,
    scanned_at: new Date().toISOString(),
    last_error: lastError,
  };
  if (lastFound !== null) patch.last_found = lastFound;
  const { error } = await db.from('ct_state').upsert(patch, { onConflict: 'owner_id' });
  if (error) console.error('Could not save CT scan state:', error.code);
}
