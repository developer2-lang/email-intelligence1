-- ============================================================================
-- Fix scrape-leads mirror errors: 42P10 (partial index) + 23505 (email unique)
-- ============================================================================
-- IDEMPOTENT - safe to re-run.
-- ============================================================================

-- 1. Make contacts.email nullable (was NOT NULL - we need NULL for no-email leads).
ALTER TABLE public.contacts ALTER COLUMN email DROP NOT NULL;

-- 2. Drop the email unique CONSTRAINT (not just the index - constraint backs the index).
--    Replace with a partial unique index that only fires for real non-empty emails.
DO $$
BEGIN
  -- Drop constraint if it exists (Supabase uses constraint, not just index)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.contacts'::regclass
      AND conname = 'contacts_email_key'
      AND contype = 'u'
  ) THEN
    ALTER TABLE public.contacts DROP CONSTRAINT contacts_email_key;
  END IF;
END $$;

-- Also drop any standalone index by that name
DROP INDEX IF EXISTS public.contacts_email_nonempty_key;

-- Re-create as a partial unique index: unique only for real, non-empty emails.
CREATE UNIQUE INDEX contacts_email_nonempty_key
  ON public.contacts (lower(trim(email)))
  WHERE email IS NOT NULL AND trim(email) <> '';

-- 3. Normalise existing '' emails -> NULL now that the column allows it.
UPDATE public.contacts
SET email = NULL
WHERE trim(coalesce(email, '')) = '';

-- 4. Remove duplicate linkedin_url rows so the full index can be built.
WITH ranked AS (
  SELECT
    c.id,
    row_number() OVER (
      PARTITION BY c.linkedin_url
      ORDER BY c.created_at ASC, c.id ASC
    ) AS rn
  FROM public.contacts c
  WHERE c.linkedin_url IS NOT NULL
)
DELETE FROM public.contacts c
USING ranked r
WHERE c.id = r.id
  AND r.rn > 1
  AND NOT EXISTS (
    SELECT 1 FROM public.weekly_email_queue q WHERE q.contact_id = c.id::text
  );

-- 5. Replace the partial linkedin_url index with a full (non-partial) one.
DROP INDEX IF EXISTS public.contacts_linkedin_url_key;
CREATE UNIQUE INDEX contacts_linkedin_url_key
  ON public.contacts (linkedin_url);

-- 6. Rewrite the AFTER INSERT trigger to store NULL (not '') for blank emails.
CREATE OR REPLACE FUNCTION public.sync_lead_insert_to_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url   text := nullif(trim(coalesce(NEW.linkedin_url, '')), '');
  v_email text := nullif(trim(coalesce(NEW.email,        '')), '');
  v_name  text := coalesce(nullif(trim(coalesce(NEW.full_name,    '')), ''), '');
  v_co    text := coalesce(nullif(trim(coalesce(NEW.company_name, '')), ''), '');
BEGIN
  IF current_setting('app.skip_lead_to_contact', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF v_url IS NOT NULL THEN
    INSERT INTO public.contacts
      (full_name, email, company, designation, industry, geography,
       role, job_title, phone, contact_type, company_category, linkedin_url)
    VALUES
      (v_name, v_email, v_co,
       NEW.designation, NEW.industry, NEW.geography,
       NEW.role, NEW.job_title, NEW.phone,
       'lead search', 'lead search', v_url)
    ON CONFLICT (linkedin_url) DO NOTHING;

  ELSIF v_email IS NOT NULL THEN
    INSERT INTO public.contacts
      (full_name, email, company, designation, industry, geography,
       role, job_title, phone, contact_type, company_category, linkedin_url)
    SELECT
      v_name, v_email, v_co,
      NEW.designation, NEW.industry, NEW.geography,
      NEW.role, NEW.job_title, NEW.phone,
      'lead search', 'lead search', NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE lower(trim(c.email)) = lower(v_email)
    );

  ELSE
    INSERT INTO public.contacts
      (full_name, email, company, designation, industry, geography,
       role, job_title, phone, contact_type, company_category, linkedin_url)
    VALUES
      (v_name, NULL, v_co,
       NEW.designation, NEW.industry, NEW.geography,
       NEW.role, NEW.job_title, NEW.phone,
       'lead search', 'lead search', NULL);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_sync_contact_on_insert ON public.leads;
CREATE TRIGGER leads_sync_contact_on_insert
AFTER INSERT ON public.leads
FOR EACH ROW
EXECUTE FUNCTION public.sync_lead_insert_to_contact();

NOTIFY pgrst, 'reload schema';