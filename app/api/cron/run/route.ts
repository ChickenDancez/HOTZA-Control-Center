import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { audit, auditState } from '@/lib/audit';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function escapeHTML(value: string) {
    return value.replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch] || ch);
}
async function notifyTelegram(message: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId)
        return;
    try {
        const reply = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
            signal: AbortSignal.timeout(3000),
        });
        if (!reply.ok)
            console.error('Telegram notification returned', reply.status);
    }
    catch (error) {
        console.error('Telegram notification failed:', error);
    }
}
export async function GET(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
        return NextResponse.json({ error: 'Missing server configuration' }, { status: 503 });
    // This privileged key must ONLY be used in this server-only cron route.
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: domains, error } = await db.from('domains')
        .select('id,owner_id,hostname,last_state,last_checked_at')
        .eq('monitoring_enabled', true).order('last_checked_at', { ascending: true, nullsFirst: true })
        .limit(10);
    if (error) {
        console.error('Cron load failed:', error);
        return NextResponse.json({ error: 'Could not read domain inventory' }, { status: 500 });
    }
    let checked = 0;
    let issues = 0;
    let unknown = 0;
    const now = Date.now();
    for (const domain of domains || []) {
        // At most once per 15 minutes per domain, even when fewer than 10 domains exist.
        if (domain.last_checked_at && now - new Date(domain.last_checked_at).getTime() < 14 * 60000)
            continue;
        const result = await audit(domain.hostname);
        const state = auditState(result);
        const { error: insertError } = await db.from('domain_checks').insert({
            owner_id: domain.owner_id, domain_id: domain.id, ...result,
        });
        if (insertError) {
            console.error('Cron save failed:', insertError);
            continue;
        }
        const patch: Record<string, string> = { last_checked_at: new Date().toISOString() };
        if (state)
            patch.last_state = state;
        const { error: updateError } = await db.from('domains').update(patch).eq('id', domain.id);
        if (updateError)
            console.error('Cron state update failed:', updateError);
        checked++;
        if (state === 'issue')
            issues++;
        if (state === null)
            unknown++;
        if (domain.last_state && state && domain.last_state !== state) {
            const at = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
            const name = escapeHTML(domain.hostname);
            if (state === 'issue') {
                await notifyTelegram(`🔴 <b>${name} มีปัญหา</b>\n${escapeHTML(result.issue || `HTTP ${result.status_code ?? '?'}`)}\nปลายทาง: ${escapeHTML(result.final_url || '-')}\nเวลา: ${at}`);
            }
            else {
                await notifyTelegram(`🟢 <b>${name} กลับมาปกติแล้ว</b>\nHTTP ${result.status_code ?? '?'} · ${result.latency_ms}ms\nเวลา: ${at}`);
            }
        }
    }
    return NextResponse.json({ checked, issues, unknown });
}
