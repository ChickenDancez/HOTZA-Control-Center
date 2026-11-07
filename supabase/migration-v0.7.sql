-- HOTZA Control Center v0.7: run AFTER migration-v0.6.sql. Safe to re-run.
-- Google search-results tracking (via SerpApi). New table only, with RLS.

CREATE TABLE IF NOT EXISTS public.serp_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  our_rank integer,
  our_url text,
  suspicious text[] NOT NULL DEFAULT '{}',
  results jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_serp_owner_keyword_date
  ON public.serp_results (owner_id, keyword, checked_at DESC);

ALTER TABLE public.serp_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS serp_results_owner ON public.serp_results;
CREATE POLICY serp_results_owner ON public.serp_results
  FOR ALL TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lookalikes ENABLE ROW LEVEL SECURITY;
