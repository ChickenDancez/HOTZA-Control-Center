-- HOTZA Control Center v0.2: RUN ONCE OR RE-RUN SAFELY.
-- Leave existing tables and RLS policies intact.
ALTER TABLE public.domains
  ADD COLUMN IF NOT EXISTS last_state text,
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS monitoring_enabled boolean NOT NULL DEFAULT true;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domains_last_state_check') THEN
    ALTER TABLE public.domains ADD CONSTRAINT domains_last_state_check
      CHECK (last_state IN ('ok', 'issue'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_domains_due
  ON public.domains(monitoring_enabled, last_checked_at NULLS FIRST);

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
  SELECT owner_id INTO v_owner FROM public.domains
  WHERE id = p_domain AND owner_id = (SELECT auth.uid());
  IF v_owner IS NULL THEN RETURN NULL; END IF;

  -- Lock at account granularity, preventing concurrent checks on DIFFERENT domains
  -- from bypassing the 30 checks/hour account-wide limit.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text, 0));

  SELECT max(checked_at) INTO v_last FROM public.domain_checks
  WHERE domain_id = p_domain;
  IF v_last IS NOT NULL AND now() - v_last < interval '60 seconds' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_count FROM public.domain_checks
  WHERE owner_id = v_owner AND checked_at > now() - interval '1 hour';
  IF v_count >= 30 THEN RETURN NULL; END IF;

  INSERT INTO public.domain_checks(owner_id,domain_id)
  VALUES(v_owner,p_domain) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_domain_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_domain_check(uuid) TO authenticated;

-- Keep RLS enabled, including for preexisting tables.
ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
