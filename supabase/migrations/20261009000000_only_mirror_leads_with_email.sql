-- Only mirror public.leads to public.contacts IF email is present.
-- If email is missing, do NOT insert into public.contacts.
-- When a lead's email is later updated (e.g. enrichment or manual edit), mirror it to public.contacts.

-- 1. Rewrite sync_lead_insert_to_contact() trigger function
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

  -- CRITICAL REQUIREMENT: If email is missing, do NOT mirror into contacts.
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

DROP TRIGGER IF EXISTS leads_sync_contact_on_insert ON public.leads;
CREATE TRIGGER leads_sync_contact_on_insert
AFTER INSERT ON public.leads
FOR EACH ROW
EXECUTE FUNCTION public.sync_lead_insert_to_contact();

-- 2. Trigger on lead email UPDATE: when an email is added or updated on a lead, mirror it to contacts
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

  -- Only trigger if the lead now has a valid email and it is new/changed
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

DROP TRIGGER IF EXISTS leads_sync_contact_on_update ON public.leads;
CREATE TRIGGER leads_sync_contact_on_update
AFTER UPDATE OF email ON public.leads
FOR EACH ROW
EXECUTE FUNCTION public.sync_lead_email_update_to_contact();

-- 3. Cleanup existing contacts that originated from lead search without an email
DELETE FROM public.contacts
WHERE (email IS NULL OR trim(email) = '' OR trim(email) = '—' OR trim(email) = '-')
  AND (
    contact_type ILIKE 'lead search%'
    OR contact_type ILIKE 'lead generation%'
    OR company_category ILIKE 'lead search%'
    OR linkedin_url IS NOT NULL
  );

NOTIFY pgrst, 'reload schema';
