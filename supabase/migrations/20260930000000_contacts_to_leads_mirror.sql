-- ============================================================================
-- Contacts → Leads mirror (for the Contacts page "Lead Search" / "Weekly Queue"
-- tabs, which render a live mirror of public.leads).
-- ============================================================================
-- Reverses the existing leads → 'lead search' contact sync so that a contact
-- added ANYWHERE (Add Contact modal, Excel import, Lusha mirror) also creates a
-- leads row. The two new Contacts tabs read public.leads, so mirrored contacts
-- appear there immediately after the UI re-fetches.
--
-- Loop / pollution guards:
--   * Contacts created BY the leads → contacts sync (contact_type = 'lead search')
--     are skipped, so a leads insert never piles back into leads.
--   * While the mirror insert runs it sets app.skip_lead_to_contact = true, so
--     the leads → contacts sync ignores the mirrored row and does NOT spawn a
--     duplicate 'lead search' contact.
--   * A mirrored lead is only inserted when no existing lead shares the same
--     email, so re-imports of the same person do not duplicate.
--
-- Requires: linkedin_url still NOT NULL on public.leads is relaxed (mirrored
-- contacts have no LinkedIn URL). Existing leads are untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Allow leads without a LinkedIn URL (mirrored contacts have none).
-- ---------------------------------------------------------------------------
alter table public.leads alter column linkedin_url drop not null;

-- ---------------------------------------------------------------------------
-- 2. Leads → contacts sync: honor the mirror's skip flag.
--    (Behavior for existing lead flows is unchanged; the flag is only set
--    inside sync_contact_insert_to_lead below.)
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
  if current_setting('app.skip_lead_to_contact', true) = 'true' then
    return new;
  end if;
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
-- 3. Contacts → leads mirror trigger function.
-- ---------------------------------------------------------------------------
create or replace function public.sync_contact_insert_to_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(trim(coalesce(new.email, '')), '');
begin
  if lower(coalesce(new.contact_type, '')) = 'lead search' then
    return new;
  end if;
  if v_email is null and nullif(trim(coalesce(new.full_name, '')), '') is null then
    return new;
  end if;
  perform set_config('app.skip_lead_to_contact', 'true', true);
  insert into public.leads
    (user_id, full_name, email, phone, linkedin_url, company_name, designation,
     role, job_title, industry, geography, location, source_query)
  select
    auth.uid(), coalesce(new.full_name, ''), new.email, new.phone,
    new.linkedin_url, new.company, new.designation, new.role, new.job_title,
    new.industry, new.geography, new.city, 'Contacts'
  where not exists (
    select 1 from public.leads l
    where l.email is not null and l.email <> ''
      and lower(l.email) = lower(coalesce(new.email, ''))
  )
  on conflict (user_id, linkedin_url) do nothing;
  perform set_config('app.skip_lead_to_contact', 'false', true);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Attach the mirror trigger. Idempotent.
-- ---------------------------------------------------------------------------
drop trigger if exists contacts_mirror_to_leads_on_insert on public.contacts;
create trigger contacts_mirror_to_leads_on_insert
after insert on public.contacts
for each row
execute function public.sync_contact_insert_to_lead();

-- Make PostgREST pick up schema changes immediately.
notify pgrst, 'reload schema';