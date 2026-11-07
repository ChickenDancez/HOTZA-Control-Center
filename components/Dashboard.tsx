'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Globe2,
  History,
  LockKeyhole,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  supabaseClient,
  type CTState,
  type Domain,
  type Check,
  type Incident,
  type SerpResult,
} from '@/lib/supabase';
import type { SupabaseClient, Session } from '@supabase/supabase-js';
const navigation = [
  { id: 'overview', name: 'ภาพรวม', icon: Activity },
  { id: 'domains', name: 'โดเมน', icon: Globe2 },
  { id: 'incidents', name: 'เว็บสวมรอย / เหตุการณ์', icon: ShieldCheck },
  { id: 'search', name: 'ผลค้นหา Google', icon: Search },
  { id: 'history', name: 'ประวัติการตรวจสอบ', icon: History },
];
function time(d: string) {
  return new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}
function daysLeft(iso: string | null) {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
}
function levelClass(level: 'ok' | 'warn' | 'bad' | null) {
  if (level === 'ok') return 'good';
  if (level === 'warn') return 'warn';
  if (level === 'bad') return 'bad';
  return 'neutral';
}
function sslText(d: Domain) {
  if (d.ssl_error) return d.ssl_error;
  const days = daysLeft(d.ssl_expires_at);
  if (days === null) return 'ยังไม่ตรวจ';
  return days < 0 ? 'หมดอายุแล้ว' : `เหลือ ${days} วัน`;
}
function expiryText(d: Domain) {
  const days = daysLeft(d.domain_expires_at);
  if (days === null) return d.domain_error || 'ยังไม่ตรวจ';
  return days < 0 ? 'หมดอายุแล้ว' : `เหลือ ${days} วัน`;
}
function status(c?: Check) {
  if (!c) return { name: 'ยังไม่ตรวจ', cls: 'neutral' };
  if (c.status_code === 405 || c.status_code === 501)
    return { name: 'เว็บไม่ตอบ HEAD / ยังสรุปไม่ได้', cls: 'neutral' };
  if (c.issue) return { name: 'ต้องตรวจสอบ', cls: 'bad' };
  return { name: 'ปกติ', cls: 'good' };
}
export default function Dashboard() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tab, setTab] = useState('overview');
  const [domains, setDomains] = useState<Domain[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [ctState, setCtState] = useState<CTState | null>(null);
  const [ctScanning, setCtScanning] = useState(false);
  const [serp, setSerp] = useState<SerpResult[]>([]);
  const [serpRunning, setSerpRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [newHost, setNewHost] = useState('');
  const [role, setRole] = useState<Domain['role']>('watch');
  const [incidentTitle, setIncidentTitle] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [severity, setSeverity] = useState('review');
  useEffect(() => {
    try {
      const s = supabaseClient();
      setClient(s);
      s.auth.getSession().then((r) => setSession(r.data.session));
      const { data } = s.auth.onAuthStateChange((_e, session) => setSession(session));
      return () => data.subscription.unsubscribe();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Configuration error');
    }
  }, []);
  async function reload() {
    if (!client || !session) return;
    const [d, c, i] = await Promise.all([
      client.from('domains').select('*').order('created_at', { ascending: false }),
      client.from('domain_checks').select('*').order('checked_at', { ascending: false }).limit(200),
      client.from('incidents').select('*').order('created_at', { ascending: false }).limit(100),
    ]);
    if (d.error || c.error || i.error)
      setMessage(d.error?.message || c.error?.message || i.error?.message || 'โหลดข้อมูลไม่สำเร็จ');
    setDomains(d.data || []);
    setChecks(c.data || []);
    setIncidents(i.data || []);
    // Optional (v0.6 migration). Ignore errors so older databases still load.
    const ct = await client.from('ct_state').select('*').maybeSingle();
    setCtState(ct.error ? null : (ct.data as CTState | null));
    // Optional (v0.7 migration).
    const sr = await client
      .from('serp_results')
      .select('*')
      .order('checked_at', { ascending: false })
      .limit(60);
    setSerp(sr.error ? [] : ((sr.data ?? []) as SerpResult[]));
  }
  useEffect(() => {
    if (session && client) void reload();
    else {
      setDomains([]);
      setChecks([]);
      setIncidents([]);
    }
  }, [session?.user.id, client]); // session refresh need not reload all lists
  const serpLatest = useMemo(() => {
    const map = new Map<string, SerpResult>();
    for (const r of serp) if (!map.has(r.keyword)) map.set(r.keyword, r);
    return [...map.values()];
  }, [serp]);
  const latest = useMemo(() => {
    const map: Record<string, Check> = {};
    for (const c of checks) if (!map[c.domain_id]) map[c.domain_id] = c;
    return map;
  }, [checks]);
  const failures = domains.filter(
    (d) =>
      latest[d.id]?.issue && latest[d.id]?.status_code !== 405 && latest[d.id]?.status_code !== 501,
  ).length;
  async function auth(e: React.FormEvent) {
    e.preventDefault();
    if (!client) return;
    setLoading(true);
    setMessage('');
    const res = await client.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (res.error) setMessage(res.error.message);
  }
  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!client || !session) return;
    const host = newHost
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
      setMessage('กรุณาใส่ชื่อโดเมน เช่น hotza888.pro');
      return;
    }
    const { error } = await client
      .from('domains')
      .insert({ owner_id: session.user.id, hostname: host, role });
    if (error) setMessage(error.message);
    else {
      setNewHost('');
      setMessage('เพิ่มโดเมนแล้ว');
      await reload();
    }
  }
  async function deleteDomain(id: string) {
    if (!client || !window.confirm('ลบโดเมนและประวัติการตรวจสอบนี้?')) return;
    const { error } = await client.from('domains').delete().eq('id', id);
    if (error) setMessage(error.message);
    else await reload();
  }
  async function runCheck(id: string) {
    if (!client) return;
    setChecking(id);
    setMessage('');
    try {
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('กรุณาเข้าสู่ระบบใหม่');
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ domain_id: id }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'ตรวจสอบไม่สำเร็จ');
      setMessage('ตรวจโดเมนเรียบร้อย');
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'ตรวจสอบไม่สำเร็จ');
    } finally {
      setChecking(null);
    }
  }
  async function acknowledgeNs(d: Domain) {
    if (!client) return;
    const { error } = await client.from('domains').update({ ns_changed_at: null }).eq('id', d.id);
    if (error) setMessage(error.message);
    else await reload();
  }
  async function toggleMonitor(d: Domain) {
    if (!client) return;
    const { error } = await client
      .from('domains')
      .update({ monitoring_enabled: !d.monitoring_enabled })
      .eq('id', d.id);
    if (error) setMessage(error.message);
    else await reload();
  }
  async function runSerpCheck() {
    if (!client) return;
    setSerpRunning(true);
    setMessage('');
    try {
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('กรุณาเข้าสู่ระบบใหม่');
      const res = await fetch('/api/serp/run', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'ตรวจไม่สำเร็จ');
      setMessage('อัปเดตผลค้นหาแล้ว');
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'ตรวจไม่สำเร็จ');
    } finally {
      setSerpRunning(false);
    }
  }
  async function runCtScan() {
    if (!client) return;
    setCtScanning(true);
    setMessage('');
    try {
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('กรุณาเข้าสู่ระบบใหม่');
      const res = await fetch('/api/ct/scan', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'สแกนไม่สำเร็จ');
      setMessage(
        result.found.length
          ? `พบเว็บชื่อคล้ายใหม่ ${result.found.length} รายการ`
          : 'สแกนแล้ว ไม่พบชื่อใหม่',
      );
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'สแกนไม่สำเร็จ');
      await reload();
    } finally {
      setCtScanning(false);
    }
  }
  async function addIncident(e: React.FormEvent) {
    e.preventDefault();
    if (!client || !session) return;
    const { error } = await client.from('incidents').insert({
      owner_id: session.user.id,
      title: incidentTitle,
      kind: 'impersonation',
      severity,
      reference_url: referenceUrl || null,
      notes: notes || null,
    });
    if (error) setMessage(error.message);
    else {
      setIncidentTitle('');
      setReferenceUrl('');
      setNotes('');
      setMessage('บันทึกเหตุการณ์แล้ว');
      await reload();
    }
  }
  if (!client)
    return (
      <main className="auth-bg">
        <div className="auth-card">
          <div className="brand-icon">
            <ShieldCheck />
          </div>
          <h1>HOTZA Control Center</h1>
          <p>ตั้งค่า Supabase เพื่อเริ่มใช้งาน</p>
          <div className="notice">{message || 'กำลังเริ่มระบบ...'}</div>
          <small>ดูไฟล์ README.md และ .env.example</small>
        </div>
      </main>
    );
  if (!session)
    return (
      <main className="auth-bg">
        <div className="auth-card">
          <div className="brand-icon">
            <ShieldCheck />
          </div>
          <h1>HOTZA Control Center</h1>
          <p>ระบบติดตามโดเมนและเฝ้าระวังการสวมรอย</p>
          <form onSubmit={auth}>
            <label>
              อีเมล
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
              />
            </label>
            <label>
              รหัสผ่าน
              <input
                required
                type="password"
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="primary full" disabled={loading}>
              {loading ? 'กำลังดำเนินการ...' : 'เข้าสู่ระบบ'} <ArrowRight size={16} />
            </button>
          </form>
          {message && <div className="notice">{message}</div>}
          <div className="privacy">
            <LockKeyhole size={14} /> ข้อมูลส่วนตัวแยกด้วย Supabase Row Level Security
          </div>
        </div>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="identity">
          <div className="brand-icon small">
            <ShieldCheck />
          </div>
          <div>
            <b>HOTZA CONTROL</b>
            <small>Domain Intelligence · v0.2</small>
          </div>
        </div>
        <nav>
          {navigation.map((item) => (
            <button
              key={item.id}
              className={'nav-link ' + (tab === item.id ? 'active' : '')}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={18} />
              {item.name}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <small className="break-email">{session.user.email}</small>
          <button className="nav-link" onClick={() => client.auth.signOut()}>
            <LogOut size={17} />
            ออกจากระบบ
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand">HOTZA CONTROL</div>
          <span className="top-tag">
            <span className="pulse" /> Private workspace
          </span>
          <button className="quiet" onClick={() => void reload()}>
            <RefreshCw size={16} />
            รีเฟรชข้อมูล
          </button>
        </header>
        <main className="content">
          {message && (
            <div className="notice dismiss" onClick={() => setMessage('')}>
              {message} <span>×</span>
            </div>
          )}
          {tab === 'overview' && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">OVERVIEW / MONITORING</div>
                  <h1>ภาพรวมการเฝ้าระวัง</h1>
                  <p>สถานะจากฐานข้อมูลของคุณ ไม่ใช่ตัวเลขจำลอง</p>
                </div>
                <button className="primary" onClick={() => setTab('domains')}>
                  <Plus size={16} />
                  เพิ่มโดเมน
                </button>
              </div>
              <div className="stats">
                <div className="stat">
                  <span>
                    โดเมนในระบบ <Globe2 size={18} />
                  </span>
                  <strong>{domains.length}</strong>
                  <small>รายการที่บันทึกไว้</small>
                </div>
                <div className="stat">
                  <span>
                    ตรวจแล้ว <CheckCircle2 size={18} />
                  </span>
                  <strong>{Object.keys(latest).length}</strong>
                  <small>มีผลตรวจล่าสุด</small>
                </div>
                <div className="stat">
                  <span>
                    พบความผิดปกติ <AlertTriangle size={18} />
                  </span>
                  <strong>{failures}</strong>
                  <small>ตามผล HTTP/Redirect</small>
                </div>
                <div className="stat">
                  <span>
                    เหตุการณ์สวมรอย <ShieldCheck size={18} />
                  </span>
                  <strong>{incidents.filter((x) => x.severity !== 'resolved').length}</strong>
                  <small>ยังไม่ปิดเคส</small>
                </div>
              </div>
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>โดเมนที่ติดตาม</h2>
                    <p>สถานะการตรวจล่าสุด</p>
                  </div>
                  <button className="text-button" onClick={() => setTab('domains')}>
                    ดูทั้งหมด <ArrowRight size={15} />
                  </button>
                </div>
                {domains.length === 0 ? (
                  <div className="empty">
                    <Globe2 />
                    <b>ยังไม่มีโดเมนในระบบ</b>
                    <p>เริ่มต้นจากเพิ่ม hotza888.pro หรือโดเมนที่คุณถือครอง</p>
                    <button className="primary" onClick={() => setTab('domains')}>
                      เพิ่มโดเมน
                    </button>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>โดเมน</th>
                          <th>ประเภท</th>
                          <th>สถานะ</th>
                          <th>ตรวจล่าสุด</th>
                        </tr>
                      </thead>
                      <tbody>
                        {domains.slice(0, 8).map((d) => (
                          <tr key={d.id}>
                            <td className="domain-name">{d.hostname}</td>
                            <td>{d.role}</td>
                            <td>
                              <span className={'pill ' + status(latest[d.id]).cls}>
                                {status(latest[d.id]).name}
                              </span>
                            </td>
                            <td>{latest[d.id] ? time(latest[d.id].checked_at) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="info-row">
                <div className="info-card">
                  <Search size={20} />
                  <b>Google Search Console</b>
                  <p>
                    การเชื่อมต่อ API อยู่ในแผนระยะถัดไป รุ่นนี้ยังไม่มีข้อมูลอันดับ Google อัตโนมัติ
                  </p>
                </div>
                <div className="info-card">
                  <ShieldCheck size={20} />
                  <b>Brand protection</b>
                  <p>บันทึกเว็บไซต์ต้องสงสัย หลักฐาน และสถานะการตรวจสอบได้จากเมนูเหตุการณ์</p>
                </div>
              </section>
            </>
          )}
          {tab === 'domains' && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">DOMAIN INVENTORY</div>
                  <h1>จัดการโดเมน</h1>
                  <p>
                    ตรวจ HTTPS ด้วย HEAD เท่านั้น • 405/501 ไม่ยืนยันผลการเข้าถึงผ่านเบราว์เซอร์
                  </p>
                </div>
              </div>
              <section className="panel form-panel">
                <h2>เพิ่มโดเมนเพื่อตรวจสอบ</h2>
                <form className="inline-form" onSubmit={addDomain}>
                  <label>
                    ชื่อโดเมน
                    <input
                      value={newHost}
                      onChange={(e) => setNewHost(e.target.value)}
                      placeholder="hotza888.pro"
                      required
                    />
                  </label>
                  <label>
                    ประเภท
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as Domain['role'])}
                    >
                      <option value="primary">เว็บไซต์หลัก</option>
                      <option value="legacy">โดเมนเก่า</option>
                      <option value="watch">เฝ้าระวัง</option>
                    </select>
                  </label>
                  <button className="primary" type="submit">
                    <Plus size={16} />
                    เพิ่มโดเมน
                  </button>
                </form>
                <p className="hint">
                  เพิ่มเฉพาะโดเมนที่คุณได้รับอนุญาตให้ตรวจสอบ การทดสอบจะใช้ HEAD และติดตาม Redirect
                  ไม่เกิน 5 ครั้ง
                </p>
              </section>
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>รายการโดเมนทั้งหมด</h2>
                    <p>{domains.length} โดเมน</p>
                  </div>
                </div>
                {domains.length === 0 ? (
                  <div className="empty">ยังไม่มีข้อมูล</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>โดเมน</th>
                          <th>ประเภท</th>
                          <th>ผลล่าสุด</th>
                          <th>ปลายทาง</th>
                          <th>SSL / โดเมน / DNS</th>
                          <th>จัดการ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {domains.map((d) => {
                          const c = latest[d.id];
                          return (
                            <tr key={d.id}>
                              <td className="domain-name">{d.hostname}</td>
                              <td>{d.role}</td>
                              <td>
                                <span className={'pill ' + status(c).cls}>{status(c).name}</span>
                                {c?.status_code && (
                                  <div className="muted">
                                    {c.method ?? 'HEAD'} HTTP {c.status_code}
                                  </div>
                                )}
                                {c?.issue && <div className="issue">{c.issue}</div>}
                                {c?.seo_warning && <div className="seo-warn">{c.seo_warning}</div>}
                              </td>
                              <td className="cut">
                                {c?.final_url || '—'}
                                {(c?.status_code === 405 || c?.status_code === 501) && (
                                  <div className="muted">
                                    ปลายทางจาก HEAD ยังไม่ยืนยันสำหรับ GET
                                  </div>
                                )}
                                {Array.isArray(c?.redirects) ? (
                                  <div className="muted">{c.redirects.length} redirects</div>
                                ) : null}
                              </td>
                              <td>
                                <div className="watch-line">
                                  <span className={'pill ' + levelClass(d.ssl_level)}>SSL</span>
                                  <span className="muted">{sslText(d)}</span>
                                </div>
                                <div className="watch-line">
                                  <span className={'pill ' + levelClass(d.expiry_level)}>
                                    โดเมน
                                  </span>
                                  <span className="muted">{expiryText(d)}</span>
                                </div>
                                <div className="watch-line">
                                  <span
                                    className={
                                      'pill ' +
                                      (d.ns_changed_at ? 'warn' : d.ns_records ? 'good' : 'neutral')
                                    }
                                  >
                                    NS
                                  </span>
                                  <span className="muted" title={d.ns_records?.join(', ') ?? ''}>
                                    {d.ns_records?.length ? d.ns_records.join(', ') : 'ยังไม่ตรวจ'}
                                  </span>
                                </div>
                                {d.ns_changed_at && (
                                  <div className="issue">
                                    NS เปลี่ยนเมื่อ {time(d.ns_changed_at)}{' '}
                                    <button className="mini" onClick={() => void acknowledgeNs(d)}>
                                      รับทราบ
                                    </button>
                                  </div>
                                )}
                              </td>
                              <td>
                                <div className="actions">
                                  <button
                                    className="mini"
                                    disabled={checking === d.id}
                                    onClick={() => void runCheck(d.id)}
                                  >
                                    {checking === d.id ? 'กำลังตรวจ...' : 'ตรวจตอนนี้'}
                                  </button>
                                  <button className="mini" onClick={() => void toggleMonitor(d)}>
                                    {d.monitoring_enabled ? 'ปิดเฝ้าระวัง' : 'เปิดเฝ้าระวัง'}
                                  </button>
                                  <button
                                    title="ลบ"
                                    className="icon-btn"
                                    onClick={() => void deleteDomain(d.id)}
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
          {tab === 'incidents' && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">BRAND PROTECTION</div>
                  <h1>เว็บสวมรอยและเหตุการณ์</h1>
                  <p>เก็บหลักฐานไว้ตรวจสอบ ไม่ตัดสินว่าเป็นเว็บปลอมจากชื่อคล้ายอย่างเดียว</p>
                </div>
              </div>
              <section className="panel form-panel">
                <h2>สแกนหาเว็บชื่อคล้าย (ทะเบียน SSL สาธารณะ)</h2>
                <p className="muted">
                  ค้นใบรับรอง SSL ที่มีชื่อแบรนด์ของเรา แต่ไม่ใช่โดเมนของเรา ระบบสแกนเองทุกวัน 09:00
                  และไม่เปิดเว็บต้องสงสัยเอง
                </p>
                <div className="actions">
                  <button className="mini" disabled={ctScanning} onClick={() => void runCtScan()}>
                    {ctScanning ? 'กำลังสแกน (อาจนาน 1 นาที)...' : 'สแกนตอนนี้'}
                  </button>
                  <span className="muted">
                    {ctState?.scanned_at
                      ? `สแกนล่าสุด ${time(ctState.scanned_at)} · ` +
                        (ctState.last_error
                          ? `ไม่สำเร็จ: ${ctState.last_error}`
                          : `พบใหม่ ${ctState.last_found ?? 0} รายการ`)
                      : 'ยังไม่เคยสแกน'}
                  </span>
                </div>
              </section>
              <section className="panel form-panel">
                <h2>บันทึกเว็บไซต์ต้องสงสัย</h2>
                <form onSubmit={addIncident} className="incident-form">
                  <label>
                    ชื่อเหตุการณ์
                    <input
                      required
                      value={incidentTitle}
                      onChange={(e) => setIncidentTitle(e.target.value)}
                      placeholder="พบเว็บไซต์คัดลอกโลโก้และหน้าเข้าสู่ระบบ"
                    />
                  </label>
                  <label>
                    URL ที่พบ
                    <input
                      type="url"
                      value={referenceUrl}
                      onChange={(e) => setReferenceUrl(e.target.value)}
                      placeholder="https://example.com"
                    />
                  </label>
                  <label>
                    ระดับการตรวจสอบ
                    <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                      <option value="review">รอตรวจสอบ</option>
                      <option value="high">มีหลักฐานความเสี่ยงสูง</option>
                      <option value="resolved">ปิดเคสแล้ว</option>
                    </select>
                  </label>
                  <label>
                    รายละเอียดและหลักฐาน
                    <textarea
                      rows={4}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="สิ่งที่เหมือนกัน ภาพที่บันทึก วันเวลาที่พบ และผลกระทบ..."
                    />
                  </label>
                  <button className="primary">
                    <Plus size={16} />
                    บันทึกเหตุการณ์
                  </button>
                </form>
              </section>
              <section className="panel">
                <div className="panel-head">
                  <h2>ประวัติเหตุการณ์</h2>
                </div>
                {incidents.length === 0 ? (
                  <div className="empty">ยังไม่มีเหตุการณ์ที่บันทึกไว้</div>
                ) : (
                  <div className="incident-list">
                    {incidents.map((i) => (
                      <article className="incident" key={i.id}>
                        <div>
                          <b>{i.title}</b>
                          <p>{i.notes || 'ไม่มีรายละเอียด'}</p>
                          <small>{time(i.created_at)}</small>
                        </div>
                        <div className="incident-meta">
                          <span
                            className={
                              'pill ' +
                              (i.severity === 'high'
                                ? 'bad'
                                : i.severity === 'resolved'
                                  ? 'good'
                                  : 'neutral')
                            }
                          >
                            {i.severity === 'high'
                              ? 'เสี่ยงสูง'
                              : i.severity === 'resolved'
                                ? 'ปิดเคส'
                                : 'รอตรวจสอบ'}
                          </span>
                          {i.reference_url && (
                            <a href={i.reference_url} target="_blank" rel="noreferrer noopener">
                              เปิด URL <ExternalLink size={13} />
                            </a>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
          {tab === 'search' && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">SEARCH VISIBILITY</div>
                  <h1>ผลค้นหา Google</h1>
                  <p>
                    หน้าแรกของ Google ประเทศไทย ตรวจเองทุกวัน 09:30 ผ่าน SerpApi
                    ไม่เปิดเว็บต้องสงสัยเอง
                  </p>
                </div>
                <button className="mini" disabled={serpRunning} onClick={() => void runSerpCheck()}>
                  {serpRunning ? 'กำลังตรวจ...' : 'ตรวจตอนนี้'}
                </button>
              </div>
              {serpLatest.length === 0 ? (
                <section className="panel">
                  <div className="empty">ยังไม่มีข้อมูล กด "ตรวจตอนนี้" หรือรอรอบ 09:30</div>
                </section>
              ) : (
                serpLatest.map((r) => {
                  const history = serp
                    .filter((h) => h.keyword === r.keyword)
                    .slice(0, 14)
                    .reverse();
                  return (
                    <section className="panel" key={r.id}>
                      <div className="panel-head">
                        <div>
                          <h2>คำค้น “{r.keyword}”</h2>
                          <p>
                            ตรวจล่าสุด {time(r.checked_at)} · อันดับเว็บเรา{' '}
                            <b>{r.our_rank ?? 'ไม่ติดหน้าแรก'}</b>
                            {r.suspicious.length > 0 &&
                              ` · เว็บต้องสงสัย ${r.suspicious.length} รายการ`}
                          </p>
                          <p className="muted">
                            ย้อนหลัง: {history.map((h) => h.our_rank ?? '–').join(' → ')}
                          </p>
                        </div>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>อันดับ</th>
                              <th>โดเมน</th>
                              <th>หัวข้อ</th>
                              <th>ประเภท</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.results.map((h) => (
                              <tr key={h.position + h.link}>
                                <td>{h.position}</td>
                                <td className="domain-name">{h.domain}</td>
                                <td className="cut">{h.title}</td>
                                <td>
                                  <span
                                    className={
                                      'pill ' +
                                      (h.kind === 'ours'
                                        ? 'good'
                                        : h.kind === 'suspicious'
                                          ? 'bad'
                                          : 'neutral')
                                    }
                                  >
                                    {h.kind === 'ours'
                                      ? 'เว็บเรา'
                                      : h.kind === 'suspicious'
                                        ? 'ต้องสงสัย'
                                        : 'อื่น ๆ'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  );
                })
              )}
            </>
          )}
          {tab === 'history' && (
            <>
              <div className="heading">
                <div>
                  <div className="eyebrow">AUDIT TRAIL</div>
                  <h1>ประวัติผลตรวจโดเมน</h1>
                  <p>ย้อนหลัง 200 รายการล่าสุดจากฐานข้อมูล</p>
                </div>
              </div>
              <section className="panel">
                {checks.length === 0 ? (
                  <div className="empty">
                    <Clock3 />
                    ยังไม่มีผลตรวจ ให้ไปที่หน้าโดเมนแล้วกด “ตรวจตอนนี้”
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>เวลา</th>
                          <th>โดเมน</th>
                          <th>HTTP</th>
                          <th>Redirect</th>
                          <th>ผลตรวจ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {checks.map((c) => (
                          <tr key={c.id}>
                            <td>{time(c.checked_at)}</td>
                            <td className="domain-name">
                              {domains.find((d) => d.id === c.domain_id)?.hostname || '—'}
                            </td>
                            <td>{c.status_code ?? '—'}</td>
                            <td>{Array.isArray(c.redirects) ? c.redirects.length : '—'}</td>
                            <td>
                              <span className={'pill ' + status(c).cls}>{c.issue || 'OK'}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
