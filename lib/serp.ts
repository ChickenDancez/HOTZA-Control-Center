import type { SupabaseClient } from '@supabase/supabase-js';
import { escapeHTML, notifyTelegram } from '@/lib/alerts';
import { registrableDomain } from '@/lib/rdap';
import { brandKeywords } from '@/lib/ct';

/**
 * Google search-results tracking through SerpApi (a paid, terms-compliant
 * search API). We never query Google directly.
 *
 * For each brand keyword we read the first results page in Thailand and record:
 * - where our own domains rank
 * - which result domains contain the brand keyword but are not ours (suspicious)
 *
 * The API key is a server-only secret: SERPAPI_KEY (never NEXT_PUBLIC_).
 */

const TIMEOUT_MS = 30000;
const MAX_BYTES = 2 * 1024 * 1024;

export type SerpHit = {
  position: number;
  domain: string;
  link: string;
  title: string;
  kind: 'ours' | 'suspicious' | 'other';
};

export type SerpRun = {
  ok: boolean;
  error: string | null;
  keyword: string | null;
  our_rank: number | null;
  our_url: string | null;
  suspicious: string[];
};

function hostOf(link: string) {
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isOwn(host: string, ownDomains: string[]) {
  return ownDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

async function fetchResults(
  keyword: string,
): Promise<{ position: number; link: string; title: string }[] | null> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return null;
  const params = new URLSearchParams({
    engine: 'google',
    q: keyword,
    google_domain: 'google.co.th',
    gl: 'th',
    hl: 'th',
    api_key: key,
  });
  try {
    const res = await fetch(`https://serpapi.com/search.json?${params}`, {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_BYTES) return null;
    const data = JSON.parse(text) as {
      error?: string;
      organic_results?: { position?: number; link?: string; title?: string }[];
    };
    if (data.error || !Array.isArray(data.organic_results)) return null;
    return data.organic_results
      .filter((r) => typeof r.link === 'string')
      .map((r, i) => ({
        position: typeof r.position === 'number' ? r.position : i + 1,
        link: String(r.link),
        title: String(r.title ?? '').slice(0, 200),
      }));
  } catch {
    // Never log the error: the request URL contains the API key.
    return null;
  }
}

/** Classify raw results. Exported for tests. */
export function classify(
  results: { position: number; link: string; title: string }[],
  keyword: string,
  ownDomains: string[],
): SerpHit[] {
  const hits: SerpHit[] = [];
  for (const r of results) {
    const domain = hostOf(r.link);
    if (!domain) continue;
    const kind = isOwn(domain, ownDomains)
      ? 'ours'
      : domain.includes(keyword)
        ? 'suspicious'
        : 'other';
    hits.push({ position: r.position, domain, link: r.link, title: r.title, kind });
  }
  return hits;
}

type Previous = { our_rank: number | null; suspicious: string[] | null } | null;

/**
 * Runs one search per brand keyword, stores the result, records new suspicious
 * domains as incidents, and alerts on Telegram when our rank changes or a new
 * suspicious domain appears.
 */
export async function runSerp(
  db: SupabaseClient,
  ownerId: string,
  ownHostnames: string[],
): Promise<SerpRun[]> {
  if (!process.env.SERPAPI_KEY) {
    return [
      {
        ok: false,
        error: 'SERPAPI_KEY is not set',
        keyword: null,
        our_rank: null,
        our_url: null,
        suspicious: [],
      },
    ];
  }
  const ownDomains = [...new Set(ownHostnames.map(registrableDomain))];
  const runs: SerpRun[] = [];

  for (const keyword of brandKeywords(ownHostnames)) {
    const raw = await fetchResults(keyword);
    if (!raw) {
      runs.push({
        ok: false,
        error: 'Search API failed',
        keyword,
        our_rank: null,
        our_url: null,
        suspicious: [],
      });
      continue;
    }

    const hits = classify(raw, keyword, ownDomains);
    const ours = hits.find((h) => h.kind === 'ours') ?? null;
    const suspicious = [
      ...new Set(hits.filter((h) => h.kind === 'suspicious').map((h) => h.domain)),
    ];

    const { data: prevRow } = await db
      .from('serp_results')
      .select('our_rank,suspicious')
      .eq('owner_id', ownerId)
      .eq('keyword', keyword)
      .order('checked_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const prev = prevRow as Previous;

    const { error } = await db.from('serp_results').insert({
      owner_id: ownerId,
      keyword,
      our_rank: ours?.position ?? null,
      our_url: ours?.link ?? null,
      suspicious,
      results: hits,
    });
    if (error) {
      console.error('Could not save search results:', error.code);
      runs.push({
        ok: false,
        error: 'Could not save results',
        keyword,
        our_rank: null,
        our_url: null,
        suspicious: [],
      });
      continue;
    }

    // New suspicious domains: dedupe through lookalikes, then open an incident.
    let fresh: string[] = [];
    if (suspicious.length) {
      const { data } = await db
        .from('lookalikes')
        .upsert(
          suspicious.map((hostname) => ({ owner_id: ownerId, hostname, source: 'serp' })),
          { onConflict: 'owner_id,hostname', ignoreDuplicates: true },
        )
        .select('hostname');
      fresh = (data ?? []).map((r) => r.hostname as string);
      if (fresh.length) {
        const { error: incidentError } = await db.from('incidents').insert(
          fresh.map((name) => {
            const hit = hits.find((h) => h.domain === name);
            return {
              owner_id: ownerId,
              title: `เว็บชื่อคล้ายในผล Google: ${name}`,
              kind: 'impersonation',
              severity: 'review',
              reference_url: null,
              notes:
                `พบในผลค้นหา Google คำว่า "${keyword}" อันดับ ${hit?.position ?? '?'} ` +
                `(${hit?.link ?? name}) ระบบไม่ได้เปิดเว็บนี้ ตรวจสอบเองก่อนแจ้ง`,
            };
          }),
        );
        if (incidentError) console.error('Could not create search incidents:', incidentError.code);
      }
    }

    // Telegram: only when something changed since the previous run.
    const lines: string[] = [];
    const rank = ours?.position ?? null;
    if (prev && prev.our_rank !== rank) {
      const before = prev.our_rank ?? 'ไม่ติดหน้าแรก';
      const after = rank ?? 'ไม่ติดหน้าแรก';
      const icon = rank === null || (prev.our_rank !== null && rank > prev.our_rank) ? '🔻' : '🔺';
      lines.push(`${icon} อันดับเว็บเรา: ${before} → ${after}`);
    }
    if (fresh.length) {
      lines.push(`🕵️ เว็บชื่อคล้ายใหม่ในผลค้นหา: ${fresh.map(escapeHTML).join(', ')}`);
    }
    if (!prev) {
      lines.push(
        `📊 เริ่มติดตามแล้ว อันดับเว็บเรา: ${rank ?? 'ไม่ติดหน้าแรก'}` +
          (suspicious.length ? ` · เว็บต้องสงสัย ${suspicious.length} รายการ` : ''),
      );
    }
    if (lines.length) {
      await notifyTelegram(`<b>Google "${escapeHTML(keyword)}"</b>\n${lines.join('\n')}`);
    }

    runs.push({
      ok: true,
      error: null,
      keyword,
      our_rank: rank,
      our_url: ours?.link ?? null,
      suspicious,
    });
  }
  return runs;
}
