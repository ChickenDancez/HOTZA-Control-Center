-- HOTZA Control Center v0.3: run AFTER migration-v0.2.sql. Safe to re-run.
-- Leaves every table, RLS setting and policy intact.

-- 1) Mark where each check came from, so cron checks do not use up
--    the 30/hour manual budget.
ALTER TABLE public.domain_checks
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_checks_source_check'
  ) THEN
    ALTER TABLE public.domain_checks
      ADD CONSTRAINT domain_checks_source_check
      CHECK (source IN ('manual', 'cron'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_checks_owner_source_date
  ON public.domain_checks (owner_id, source, checked_at DESC);

-- 2) Same atomic claim as v0.2, but the account cap counts manual checks only.
CREATE OR REPLACE FUNCTION public.claim_domain_check(p_domain uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_last timestamptz;
  v_count integer;
  v_id uuid;
BEGIN
  SELECT owner_id INTO v_owner
  FROM public.domains
  WHERE id = p_domain
    AND owner_id = (SELECT auth.uid());

  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  -- One lock per account: concurrent checks on different domains
  -- cannot slip past the account-wide cap.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text, 0));

  -- 1 manual check per domain per 60 seconds.
  SELECT max(checked_at) INTO v_last
  FROM public.domain_checks
  WHERE domain_id = p_domain
    AND source = 'manual';

  IF v_last IS NOT NULL AND now() - v_last < interval '60 seconds' THEN
    RETURN NULL;
  END IF;

  -- 30 manual checks per account per hour.
  SELECT count(*) INTO v_count
  FROM public.domain_checks
  WHERE owner_id = v_owner
    AND source = 'manual'
    AND checked_at > now() - interval '1 hour';

  IF v_count >= 30 THEN
    RETURN NULL;
  END IF;

  -- Reserve the row before the slow network check runs.
  INSERT INTO public.domain_checks (owner_id, domain_id, source)
  VALUES (v_owner, p_domain, 'manual')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_domain_check(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_domain_check(uuid) TO authenticated;

ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
