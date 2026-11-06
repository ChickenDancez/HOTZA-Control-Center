import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { audit, auditState } from '@/lib/audit';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) {
    try {
        const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
        if (!token)
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (!url || !key)
            return NextResponse.json({ error: 'Not configured' }, { status: 503 });
        const db = createClient(url, key, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false },
        });
        const { data: { user }, error: authError } = await db.auth.getUser(token);
        if (authError || !user)
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const body = await req.json();
        if (typeof body?.domain_id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(body.domain_id)) {
            return NextResponse.json({ error: 'Invalid domain' }, { status: 400 });
        }
        const { data: domain } = await db.from('domains')
            .select('id,hostname,last_state').eq('id', body.domain_id).eq('owner_id', user.id).single();
        if (!domain)
            return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
        const { data: claimId, error: claimError } = await db.rpc('claim_domain_check', {
            p_domain: domain.id,
        });
        if (claimError) {
            console.error('Rate limit claim failed:', claimError);
            return NextResponse.json({ error: 'Run the v0.2 SQL migration first' }, { status: 503 });
        }
        if (!claimId)
            return NextResponse.json({ error: 'Rate limit: 60s per domain, 30/h per account' }, { status: 429 });
        const result = await audit(domain.hostname);
        const { error: saveError } = await db.from('domain_checks')
            .update(result).eq('id', claimId).eq('domain_id', domain.id);
        if (saveError) {
            console.error('Could not save audit result:', saveError);
            return NextResponse.json({ error: 'Could not save check' }, { status: 500 });
        }
        const state = auditState(result);
        const patch: Record<string, string | null> = { last_checked_at: new Date().toISOString() };
        if (state)
            patch.last_state = state;
        const { error: domainError } = await db.from('domains').update(patch).eq('id', domain.id);
        if (domainError)
            console.error('Could not update domain state:', domainError);
        return NextResponse.json({ ...result, state: state ?? 'unknown' });
    }
    catch (error) {
        console.error('Check failed:', error);
        return NextResponse.json({ error: 'Check failed' }, { status: 500 });
    }
}
