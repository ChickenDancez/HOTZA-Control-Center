import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditResult } from '@/lib/audit';

type State = 'ok' | 'issue';

export function escapeHTML(value: string) {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch] || ch,
  );
}

export async function notifyTelegram(message: string) {
  // Server-only secrets. Never prefix these with NEXT_PUBLIC_.
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const reply = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(3000),
    });
    if (!reply.ok) console.error('Telegram notification returned', reply.status);
  } catch {
    // Do not log the error object: it can contain the bot token in the URL.
    console.error('Telegram notification failed');
  }
}

function transitionMessage(hostname: string, state: State, result: AuditResult) {
  const at = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  const name = escapeHTML(hostname);
  if (state === 'issue') {
    const reason = escapeHTML(result.issue || `HTTP ${result.status_code ?? '?'}`);
    const target = escapeHTML(result.final_url || '-');
    return `🔴 <b>${name} มีปัญหา</b>\n${reason}\nปลายทาง: ${target}\nเวลา: ${at}`;
  }
  return (
    `🟢 <b>${name} กลับมาปกติแล้ว</b>\n` +
    `HTTP ${result.status_code ?? '?'} · ${result.latency_ms}ms\nเวลา: ${at}`
  );
}

/**
 * Saves the new state and sends Telegram ONLY when a known state changes
 * (ok -> issue or issue -> ok). The first state and unchanged states are silent.
 *
 * The update is a compare-and-set on last_state, so when the manual check and
 * the cron run finish at the same time, only one of them wins and alerts once.
 *
 * Used by both /api/check (user's own client, RLS applies) and /api/cron/run.
 */
export async function applyState(
  db: SupabaseClient,
  domain: { id: string; hostname: string; last_state: State | null },
  state: State | null,
  result: AuditResult,
) {
  if (!state || state === domain.last_state) return;

  const base = db.from('domains').update({ last_state: state }).eq('id', domain.id);
  const guarded =
    domain.last_state === null
      ? base.is('last_state', null)
      : base.eq('last_state', domain.last_state);
  const { data, error } = await guarded.select('id');

  if (error) {
    console.error('Could not update domain state');
    return;
  }
  const won = Array.isArray(data) && data.length === 1;
  if (won && domain.last_state !== null) {
    await notifyTelegram(transitionMessage(domain.hostname, state, result));
  }
}
