-- Fix leads RLS to allow anon and authenticated access (same as apify_scrapers and contacts)
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own leads" ON public.leads;
DROP POLICY IF EXISTS "Users insert own leads" ON public.leads;
DROP POLICY IF EXISTS "Users update own leads" ON public.leads;
DROP POLICY IF EXISTS "Users delete own leads" ON public.leads;

DROP POLICY IF EXISTS "leads select" ON public.leads;
DROP POLICY IF EXISTS "leads insert" ON public.leads;
DROP POLICY IF EXISTS "leads update" ON public.leads;
DROP POLICY IF EXISTS "leads delete" ON public.leads;

CREATE POLICY "leads select" ON public.leads FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "leads insert" ON public.leads FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "leads update" ON public.leads FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "leads delete" ON public.leads FOR DELETE TO anon, authenticated USING (true);
