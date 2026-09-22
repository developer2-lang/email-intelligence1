-- ============================================================================
-- Ensure live Lead Search ↔ Contacts triggers are ALWAYS attached.
-- ============================================================================
-- The backfill migration (20260925000000) upgraded the trigger function and
-- backfilled historical leads, but it did NOT re-create the triggers
-- themselves (those live in 20260924000000). If that migration was skipped
-- or apply order went wrong, live Add/Delete sync silently does nothing:
--   * Add:    new leads are not mirrored into contacts
--   * Delete: removed leads leave stale "lead search" contacts behind
--
-- This migration is self-healing: it create-or-replaces both trigger
-- functions and force-recreates both triggers on public.leads. The backfill
-- data is left untouched (no INSERT/DELETE on contacts here).
-- Idempotent: safe to re-run; also safe when run AFTER every prior migration.
--
-- Verify after `supabase db push`:
--   select tgname, tgrelid::regclass
--   from pg_trigger
--   where tgrelid = 'public.leads'::regclass and not tgisinternal;
-- Expect: leads_sync_contact_on_insert, leads_sync_contact_on_delete
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. INSERT trigger function (dedupe: linkedin_url → email → raw insert).
--    SECURITY DEFINER so the sync runs with the function owner's privileges
--    regardless of which role performed the lead DML (anon frontend or the
--    service-role edge function).
-- ---------------------------------------------------------------------------
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
    insert into public.contacts
      (full_name, email, company, designation, industry, geography, role, job_title,
       phone, contact_type, company_category, linkedin_url)
    values
      (coalesce(new.full_name, ''), coalesce(new.email, ''), coalesce(new.company_name, ''),
       new.designation, new.industry, new.geography, new.role, new.job_title,
       new.phone, 'lead search', 'lead search', new.linkedin_url)
    on conflict (linkedin_url) where linkedin_url is not null do nothing;
  elsif v_email is not null then
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

-- ---------------------------------------------------------------------------
-- 2. DELETE trigger function. Only removes contacts still tagged
--    'lead search' for the same linkedin_url, so contacts the user
--    re-categorized or created manually are never touched.
-- ---------------------------------------------------------------------------
create or replace function public.delete_lead_contact_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.linkedin_url is not null then
    delete from public.contacts
    where contact_type = 'lead search'
      and linkedin_url = old.linkedin_url;
  end if;
  return old;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Force (re)attach both triggers.
-- ---------------------------------------------------------------------------
drop trigger if exists leads_sync_contact_on_insert on public.leads;
create trigger leads_sync_contact_on_insert
after insert on public.leads
for each row
execute function public.sync_lead_insert_to_contact();

drop trigger if exists leads_sync_contact_on_delete on public.leads;
create trigger leads_sync_contact_on_delete
after delete on public.leads
for each row
execute function public.delete_lead_contact_sync();

-- Make PostgREST pick up schema changes immediately.
notify pgrst, 'reload schema';