-- Run in Supabase SQL Editor. Require authenticated users and RLS on all tables.
create extension if not exists pgcrypto;
create table if not exists public.domains (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 hostname text not null check (length(hostname) between 4 and 253 and hostname ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
 role text not null default 'watch' check(role in ('primary','legacy','watch')),
 notes text, created_at timestamptz not null default now(), unique(owner_id,hostname)
);
create table if not exists public.domain_checks (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 domain_id uuid not null references public.domains(id) on delete cascade,
 checked_at timestamptz not null default now(), status_code integer, final_url text,
 redirects jsonb not null default '[]'::jsonb, issue text, latency_ms integer
);
create table if not exists public.incidents (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 title text not null, kind text not null check(kind in ('impersonation','technical','search','other')),
 severity text not null default 'review' check(severity in ('review','high','resolved')),
 reference_url text, notes text, created_at timestamptz not null default now()
);
create index if not exists idx_checks_domain_date on public.domain_checks(domain_id,checked_at desc);
create index if not exists idx_incidents_owner_date on public.incidents(owner_id,created_at desc);
alter table public.domains enable row level security;
alter table public.domain_checks enable row level security;
alter table public.incidents enable row level security;
drop policy if exists domains_owner on public.domains;
create policy domains_owner on public.domains for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
drop policy if exists checks_owner on public.domain_checks;
create policy checks_owner on public.domain_checks for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()) and exists(select 1 from public.domains d where d.id=domain_id and d.owner_id=(select auth.uid())));
drop policy if exists incidents_owner on public.incidents;
create policy incidents_owner on public.incidents for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
