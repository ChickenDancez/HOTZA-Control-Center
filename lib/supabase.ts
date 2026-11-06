import { createClient } from '@supabase/supabase-js';
export function supabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('กรุณาตั้งค่า Supabase environment variables');
  return createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
}
export type RedirectHop = {
  from: string;
  to: string;
  status: number;
};
export type Domain = {
  id: string;
  owner_id: string;
  hostname: string;
  role: 'primary' | 'legacy' | 'watch';
  notes: string | null;
  created_at: string;
  last_state: 'ok' | 'issue' | null;
  last_checked_at: string | null;
  monitoring_enabled: boolean;
  ssl_expires_at: string | null;
  ssl_issuer: string | null;
  ssl_error: string | null;
  ssl_level: 'ok' | 'warn' | 'bad' | null;
  domain_expires_at: string | null;
  registrar: string | null;
  domain_error: string | null;
  expiry_level: 'ok' | 'warn' | 'bad' | null;
  ns_records: string[] | null;
  ns_changed_at: string | null;
};
export type Check = {
  id: string;
  domain_id: string;
  checked_at: string;
  status_code: number | null;
  final_url: string | null;
  redirects: RedirectHop[] | null;
  issue: string | null;
  latency_ms: number | null;
  method?: 'HEAD' | 'GET';
};
export type Incident = {
  id: string;
  owner_id: string;
  title: string;
  kind: string;
  severity: string;
  reference_url: string | null;
  notes: string | null;
  created_at: string;
};
