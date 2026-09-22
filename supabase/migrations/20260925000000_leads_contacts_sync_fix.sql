-- ============================================================================
-- Lead Search ↔ Contacts sync fix: robust trigger + full backfill
-- ============================================================================
-- Purpose:
--   1. Upgrades the AFTER INSERT trigger function so it no longer silently
--      skips leads whose linkedin_url is missing/empty: it falls back to
--      deduplicating on email, and finally inserts without a dedupe key.
--   2. Backfills EVERY existing lead (not just URL ones) into contacts with
--      contact_type / company_category = 'lead search', deduped against
--      contacts already mirrored (ON CONFLICT on linkedin_url + NOT EXISTS
--      guards). Safe to re-run (idempotent).
--
-- Deployment check (run after `supabase db push`):
--   select tgname, tgrelid::regclass from pg_trigger
--   where not tgisinternal and tgrelid = 'public.leads'::regclass;
--
-- Run this to see any leads still missing a contact after the backfill:
--   select l.id, l.linkedin_url, l.full_name, l.email, l.company_name
--   from public.leads l
--   left join public.contacts c
--     on c.linkedin_url is not null and c.linkedin_url = l.linkedin_url
--   where c.id is null;
-- ============================================================================

-- ---------------------------------------------------------------
-- 1. Upgrade the AFTER INSERT trigger function (see
--    create-leads-contact-trigger), so URL-less leads stop being skipped:
--    linkedin_url → email → raw insert, in dedupe-priority order.
-- ---------------------------------------------------------------
create or replace function public.sync_lead_insert_to_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url   text := nullif(trim(coalesce(new.linkedin_url, '')), '');
  v_email text := nullif(trim(coalesce(new.email, '')), '');
begin
  if v_url is not null then
    -- Preferred path: dedupe on the partial unique index on linkedin_url.
    insert into public.contacts
      (full_name, email, company, designation, industry, geography, role, job_title,
       phone, contact_type, company_category, linkedin_url)
    values
      (coalesce(new.full_name, ''), coalesce(new.email, ''), coalesce(new.company_name, ''),
       new.designation, new.industry, new.geography, new.role, new.job_title,
       new.phone, 'lead search', 'lead search', new.linkedin_url)
    on conflict (linkedin_url) where linkedin_url is not null do nothing;
  elsif v_email is not null then
    -- Fallback: lead has no usable URL but has an email. Dedupe against
    -- existing 'lead search' contacts by (lowercased) email so we never
    -- create duplicate people for the same address.
    insert into public.contacts
      (full_name, email, company, designation, industry, geography, role, job_title,
       phone, contact_type, company_category, linkedin_url)
    select
      coalesce(new.full_name, ''), new.email, coalesce(new.company_name, ''),
      new.designation, new.industry, new.geography, new.role, new.job_title,
      new.phone, 'lead search', 'lead search', new.linkedin_url
    where not exists (
      select 1 from public.contacts c
      where c.contact_type = 'lead search'
        and c.email is not null and c.email <> ''
        and lower(c.email) = lower(new.email)
    );
  else
    -- Last resort: no URL and no email. Insert as-is (no dedupe key exists).
    insert into public.contacts
      (full_name, email, company, designation, industry, geography, role, job_title,
       phone, contact_type, company_category, linkedin_url)
    values
      (coalesce(new.full_name, ''), '', coalesce(new.company_name, ''),
       new.designation, new.industry, new.geography, new.role, new.job_title,
       new.phone, 'lead search', 'lead search', new.linkedin_url);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------
-- 2. Backfill all leads that are missing from contacts.
--    URL rows dedupe via ON CONFLICT (linkedin_url); URL-less rows
--    dedupe via a NOT EXISTS email guard. Idempotent.
-- ---------------------------------------------------------------
insert into public.contacts
  (full_name, email, company, designation, industry, geography, role, job_title,
   phone, contact_type, company_category, linkedin_url)
select
  coalesce(nullif(trim(l.full_name), ''), ''),
  lower(coalesce(nullif(trim(l.email), ''), '')),
  coalesce(nullif(trim(l.company_name), ''), ''),
  l.designation, l.industry, l.geography, l.role, l.job_title,
  l.phone, 'lead search', 'lead search',
  nullif(trim(l.linkedin_url), '')
from public.leads l
where
  -- Skip leads that already have a mirrored contact by linkedin_url.
  not exists (
    select 1 from public.contacts c
    where c.linkedin_url is not null
      and c.linkedin_url = nullif(trim(l.linkedin_url), '')
  )
  -- For URL-less leads, also skip when a 'lead search' contact already
  -- exists for the same (lowercased) email.
  and (
    nullif(trim(l.linkedin_url), '') is not null
    or not exists (
      select 1 from public.contacts c
      where c.contact_type = 'lead search'
        and c.email is not null and c.email <> ''
        and lower(c.email) = lower(l.email)
    )
  )
on conflict (linkedin_url) where linkedin_url is not null do nothing;

-- Make PostgREST pick up schema changes immediately.
notify pgrst, 'reload schema';