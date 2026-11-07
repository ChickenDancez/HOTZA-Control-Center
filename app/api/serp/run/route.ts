import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runSerp } from '@/lib/serp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One search per brand keyword, up to 30 seconds each.
export const maxDuration = 90;

// Protects the monthly search quota.
const MIN_INTERVAL_MS = 60 * 60 * 1000;

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

    const { data: last, error: lastError } = await db
      .from('serp_results')
      .select('checked_at')
      .eq('owner_id', user.id)
      .order('checked_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) {
      return NextResponse.json({ error: 'Run the SQL migrations first' }, { status: 503 });
    }
    if (last?.checked_at && Date.now() - new Date(last.checked_at).getTime() < MIN_INTERVAL_MS) {
      return NextResponse.json({ error: 'ตรวจได้ชั่วโมงละครั้ง (ประหยัดโควตา)' }, { status: 429 });
    }

    const { data: domains } = await db.from('domains').select('hostname').eq('owner_id', user.id);
    const hostnames = (domains ?? []).map((d) => d.hostname as string);
    if (hostnames.length === 0) {
      return NextResponse.json({ error: 'ยังไม่มีโดเมน' }, { status: 400 });
    }

    const runs = await runSerp(db, user.id, hostnames);
    const ok = runs.some((r) => r.ok);
    return NextResponse.json(
      { ok, runs, error: ok ? null : (runs[0]?.error ?? 'Search failed') },
      { status: ok ? 200 : 503 },
    );
  } catch {
    console.error('Search tracking failed');
    return NextResponse.json({ error: 'Scan failed' }, { status: 500 });
  }
}
