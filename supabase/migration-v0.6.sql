-- HOTZA Control Center v0.6: run AFTER migration-v0.5.sql. Safe to re-run.
-- Lookalike-domain watch (Certificate Transparency). New tables only, with RLS.

CREATE TABLE IF NOT EXISTS public.lookalikes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  source text NOT NULL DEFAULT 'ct',
  first_seen timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, hostname)
);

CREATE TABLE IF NOT EXISTS public.ct_state (
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  scanned_at timestamptz,
  last_error text,
  last_found integer
);

ALTER TABLE public.lookalikes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ct_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lookalikes_owner ON public.lookalikes;
CREATE POLICY lookalikes_owner ON public.lookalikes
  FOR ALL TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS ct_state_owner ON public.ct_state;
CREATE POLICY ct_state_owner ON public.ct_state
  FOR ALL TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
