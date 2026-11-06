import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { audit, auditState } from '@/lib/audit';
import { applyState } from '@/lib/alerts';
import { runWatch, WATCH_COLUMNS, type WatchRow } from '@/lib/watch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return NextResponse.json({ error: 'Not configured' }, { status: 503 });

    // User's own token + anon key: every query below runs under RLS.
    const db = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: authError,
    } = await db.auth.getUser(token);
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => null);
    if (
      typeof body?.domain_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(body.domain_id)
    ) {
      return NextResponse.json({ error: 'Invalid domain' }, { status: 400 });
    }

    const { data: domain } = await db
      .from('domains')
      .select(`id,hostname,last_state,${WATCH_COLUMNS}`)
      .eq('id', body.domain_id)
      .eq('owner_id', user.id)
      .single();
    if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });

    // Atomic rate limit in Postgres (advisory lock + reserved row).
    const { data: claimId, error: claimError } = await db.rpc('claim_domain_check', {
      p_domain: domain.id,
    });
    if (claimError) {
      console.error('Rate limit claim failed:', claimError.code);
      return NextResponse.json({ error: 'Run the SQL migrations first' }, { status: 503 });
    }
    if (!claimId) {
      return NextResponse.json(
        { error: 'Rate limit: 60s per domain, 30/h per account' },
        { status: 429 },
      );
    }

    // SSL / domain expiry / nameservers run alongside the HTTP check.
    const watch = runWatch(db, domain as unknown as WatchRow).catch(() => {
      console.error('Watch failed');
    });

    let result;
    try {
      result = await audit(domain.hostname);
    } catch {
      // Never leave the reserved row empty, and never store a raw error.
      await db.from('domain_checks').update({ issue: 'Check failed' }).eq('id', claimId);
      await watch;
      return NextResponse.json({ error: 'Check failed' }, { status: 500 });
    }

    const { error: saveError } = await db
      .from('domain_checks')
      .update(result)
      .eq('id', claimId)
      .eq('domain_id', domain.id);
    if (saveError) {
      console.error('Could not save audit result:', saveError.code);
      await watch;
      return NextResponse.json({ error: 'Could not save check' }, { status: 500 });
    }

    const { error: timeError } = await db
      .from('domains')
      .update({ last_checked_at: new Date().toISOString() })
      .eq('id', domain.id);
    if (timeError) console.error('Could not update last_checked_at:', timeError.code);

    // Manual checks alert too, so a state change seen here is not swallowed.
    const state = auditState(result);
    await applyState(
      db,
      {
        id: domain.id,
        hostname: domain.hostname,
        last_state: domain.last_state as 'ok' | 'issue' | null,
      },
      state,
      result,
    );

    await watch;
    return NextResponse.json({ ...result, state: state ?? 'unknown' });
  } catch {
    console.error('Check failed');
    return NextResponse.json({ error: 'Check failed' }, { status: 500 });
  }
}
