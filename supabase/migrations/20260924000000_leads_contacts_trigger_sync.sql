-- ============================================================================
-- Lead Generation ↔ Contacts sync (Option A: PostgreSQL triggers)
-- ============================================================================
-- Makes the Lead Search ↔ Contacts page relationship a database-level
-- guarantee rather than relying only on the edge-function mirror:
--   * AFTER INSERT on public.leads  -> upsert the matching "lead search" contact
--   * AFTER DELETE on public.leads  -> delete the mirrored "lead search" contact
--
-- Behaviour notes:
--   * Rows without a linkedin_url are skipped (the mirror dedupes on
--     linkedin_url), matching the existing upsertContactMirrors behaviour.
--   * DELETE only removes contacts still tagged contact_type = 'lead search'.
--     Contacts the user re-categorized or created manually are untouched, so
--     the manual Delete Contact feature on the Contacts page is unaffected.
--   * INSERT uses ON CONFLICT ... DO NOTHING so an existing contact created
--     manually for the same URL is never clobbered or re-tagged.
--   * SECURITY DEFINER so the sync runs regardless of which client (the anon
--     frontend or an edge function) issued the lead DML.
-- Idempotent: functions are create-or-replace and triggers are dropped first.
-- ============================================================================

create or replace function public.sync_lead_insert_to_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.linkedin_url is not null then
    insert into public.contacts
      (full_name, email, company, designation, industry, geography, role, job_title,
       phone, contact_type, company_category, linkedin_url)
    values
      (coalesce(new.full_name, ''), coalesce(new.email, ''), coalesce(new.company_name, ''),
       new.designation, new.industry, new.geography, new.role, new.job_title,
       new.phone, 'lead search', 'lead search', new.linkedin_url)
    on conflict (linkedin_url) where linkedin_url is not null do nothing;
  end if;
  return new;
end;
$$;

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