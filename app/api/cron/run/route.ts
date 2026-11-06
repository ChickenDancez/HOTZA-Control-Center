import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { audit, auditState } from '@/lib/audit';
import { applyState } from '@/lib/alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Up to 10 domains x 10s budget each, plus Telegram and DB time.
export const maxDuration = 300;

const BATCH_SIZE = 10;
const MIN_INTERVAL_MS = 14 * 60 * 1000;

function authorized(header: string | null, secret: string) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authorized(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: 'Missing server configuration' }, { status: 503 });
  }

  // This privileged key must ONLY be used in this server-only cron route.
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const cutoff = new Date(Date.now() - MIN_INTERVAL_MS).toISOString();
  const { data: domains, error } = await db
    .from('domains')
    .select('id,owner_id,hostname')
    .eq('monitoring_enabled', true)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);
  if (error) {
    console.error('Cron load failed:', error.code);
    return NextResponse.json({ error: 'Could not read domain inventory' }, { status: 500 });
  }

  let checked = 0;
  let issues = 0;
  let unknown = 0;

  for (const domain of domains || []) {
    // Claim the domain atomically: if two cron runs overlap, only one checks it.
    const { data: claimed, error: claimError } = await db
      .from('domains')
      .update({ last_checked_at: new Date().toISOString() })
      .eq('id', domain.id)
      .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
      .select('id,last_state');
    if (claimError || !claimed || claimed.length !== 1) continue;
    const previous = claimed[0].last_state as 'ok' | 'issue' | null;

    const result = await audit(domain.hostname);
    const state = auditState(result);

    const { error: insertError } = await db.from('domain_checks').insert({
      owner_id: domain.owner_id,
      domain_id: domain.id,
      source: 'cron',
      ...result,
    });
    if (insertError) {
      console.error('Cron save failed:', insertError.code);
      continue;
    }

    await applyState(
      db,
      { id: domain.id, hostname: domain.hostname, last_state: previous },
      state,
      result,
    );

    checked++;
    if (state === 'issue') issues++;
    if (state === null) unknown++;
  }

  return NextResponse.json({ checked, issues, unknown });
}
