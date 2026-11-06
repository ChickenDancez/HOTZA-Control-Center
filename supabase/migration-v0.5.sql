-- HOTZA Control Center v0.5: run AFTER migration-v0.4.sql. Safe to re-run.
-- Technical SEO hints: temporary/chained redirects and X-Robots-Tag noindex.
-- Leaves every table, RLS setting and policy intact.

ALTER TABLE public.domain_checks
  ADD COLUMN IF NOT EXISTS seo_warning text;

ALTER TABLE public.domains
  ADD COLUMN IF NOT EXISTS seo_warning text;

ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
