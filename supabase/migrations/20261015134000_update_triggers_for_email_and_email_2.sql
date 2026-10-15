-- ============================================================================
-- Update PostgreSQL triggers for contacts column rename (email and email_2)
-- ============================================================================
-- The user renamed 'email_1' back to 'email', with 'email_2' as secondary email.
-- This migration updates the database trigger functions to reference NEW.email
-- and fall back to NEW.email_2.
-- ============================================================================

-- 1. Weekly email queue trigger
CREATE OR REPLACE FUNCTION public.queue_contact_for_weekly_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  -- Check primary email first; if absent, fall back to email_2
  v_email := nullif(trim(coalesce(NEW.email, NEW.email_2, '')), '');

  IF v_email IS NULL THEN
    RETURN NEW;
  END IF;

  IF exists (
    SELECT 1 FROM public.weekly_email_queue wq
    WHERE wq.email IS NOT NULL
      AND lower(trim(wq.email)) = lower(v_email)
  ) THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.weekly_email_queue
      (contact_id, email, full_name, company, designation, industry, status)
    VALUES
      (NEW.id::text, v_email, coalesce(NEW.full_name, ''), NEW.company,
       NEW.designation, coalesce(NEW.industry, ''), 'pending')
    ON CONFLICT (contact_id) DO NOTHING;
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  RETURN NEW;
END;
$$;

-- Reattach trigger
DROP TRIGGER IF EXISTS contacts_queue_weekly_email_on_insert ON public.contacts;
CREATE TRIGGER contacts_queue_weekly_email_on_insert
AFTER INSERT ON public.contacts
FOR EACH ROW
EXECUTE FUNCTION public.queue_contact_for_weekly_email();

-- 2. Ensure contacts-to-leads mirror trigger is dropped
DROP TRIGGER IF EXISTS contacts_mirror_to_leads_on_insert ON public.contacts;
DROP FUNCTION IF EXISTS public.sync_contact_insert_to_lead();

-- 3. Lead to contact sync triggers (using email)
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

  IF v_email IS NULL THEN
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
    ON CONFLICT (linkedin_url) DO UPDATE
      SET email = EXCLUDED.email,
          full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), public.contacts.full_name),
          company = COALESCE(NULLIF(EXCLUDED.company, ''), public.contacts.company);
  ELSE
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
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_lead_email_update_to_contact()
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

  IF v_email IS NOT NULL AND (OLD.email IS NULL OR trim(OLD.email) = '' OR OLD.email IS DISTINCT FROM NEW.email) THEN
    IF v_url IS NOT NULL THEN
      INSERT INTO public.contacts
        (full_name, email, company, designation, industry, geography,
         role, job_title, phone, contact_type, company_category, linkedin_url)
      VALUES
        (v_name, v_email, v_co,
         NEW.designation, NEW.industry, NEW.geography,
         NEW.role, NEW.job_title, NEW.phone,
         'lead search', 'lead search', v_url)
      ON CONFLICT (linkedin_url) DO UPDATE
        SET email = EXCLUDED.email,
            full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), public.contacts.full_name),
            company = COALESCE(NULLIF(EXCLUDED.company, ''), public.contacts.company);
    ELSE
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
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 4. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
