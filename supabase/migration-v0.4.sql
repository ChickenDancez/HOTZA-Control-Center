-- HOTZA Control Center v0.4: run AFTER migration-v0.3.sql. Safe to re-run.
-- Adds SSL, domain-expiry (RDAP) and nameserver watch results to domains.
-- Leaves every table, RLS setting and policy intact.

ALTER TABLE public.domains
  ADD COLUMN IF NOT EXISTS ssl_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS ssl_issuer text,
  ADD COLUMN IF NOT EXISTS ssl_error text,
  ADD COLUMN IF NOT EXISTS ssl_level text,
  ADD COLUMN IF NOT EXISTS domain_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS registrar text,
  ADD COLUMN IF NOT EXISTS domain_error text,
  ADD COLUMN IF NOT EXISTS expiry_level text,
  ADD COLUMN IF NOT EXISTS domain_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS ns_records text[],
  ADD COLUMN IF NOT EXISTS ns_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS watch_checked_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domains_ssl_level_check') THEN
    ALTER TABLE public.domains
      ADD CONSTRAINT domains_ssl_level_check
      CHECK (ssl_level IN ('ok', 'warn', 'bad'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domains_expiry_level_check') THEN
    ALTER TABLE public.domains
      ADD CONSTRAINT domains_expiry_level_check
      CHECK (expiry_level IN ('ok', 'warn', 'bad'));
  END IF;
END $$;

-- Which method the HTTP check used (HEAD, or GET after a 405/501).
ALTER TABLE public.domain_checks
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'HEAD';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domain_checks_method_check') THEN
    ALTER TABLE public.domain_checks
      ADD CONSTRAINT domain_checks_method_check
      CHECK (method IN ('HEAD', 'GET'));
  END IF;
END $$;

ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
