import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { scanLookalikes } from '@/lib/ct';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// crt.sh can take 20-70 seconds to answer.
export const maxDuration = 90;

const MIN_INTERVAL_MS = 10 * 60 * 1000;

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

    const { data: state, error: stateError } = await db
      .from('ct_state')
      .select('scanned_at')
      .eq('owner_id', user.id)
      .maybeSingle();
    if (stateError) {
      return NextResponse.json({ error: 'Run the SQL migrations first' }, { status: 503 });
    }
    if (state?.scanned_at && Date.now() - new Date(state.scanned_at).getTime() < MIN_INTERVAL_MS) {
      return NextResponse.json({ error: 'สแกนได้ทุก 10 นาที' }, { status: 429 });
    }

    const { data: domains } = await db.from('domains').select('hostname').eq('owner_id', user.id);
    const hostnames = (domains ?? []).map((d) => d.hostname as string);
    if (hostnames.length === 0) {
      return NextResponse.json({ error: 'ยังไม่มีโดเมน' }, { status: 400 });
    }

    const result = await scanLookalikes(db, user.id, hostnames);
    return NextResponse.json(result, { status: result.ok ? 200 : 503 });
  } catch {
    console.error('Lookalike scan failed');
    return NextResponse.json({ error: 'Scan failed' }, { status: 500 });
  }
}
