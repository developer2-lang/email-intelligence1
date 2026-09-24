-- ============================================================================
-- Fix: "there is no unique or exclusion constraint matching the ON CONFLICT
--      specification" when creating a contact.
-- ============================================================================
-- Root cause: the contacts → leads mirror trigger
-- (public.sync_contact_insert_to_lead, 20260930000000) issues
--     INSERT INTO public.leads (...) ... ON CONFLICT (user_id, linkedin_url)
--                                                 ^^^ needs a matching unique
--                                                     constraint on public.leads
-- The live public.leads table was created outside this repo and lacks that
-- composite constraint, so every contact INSERT aborts inside the trigger with
-- SQLSTATE 42P10 (no matching unique/exclusion constraint).
--
-- Fix strategy (idempotent, safe to re-run):
--   1. Rewrite the mirror function to drop the constraint-dependent
--      ON CONFLICT clause and instead catch unique_violation locally — the
--      mirror then works whether or not the constraint exists.
--   2. Add the missing UNIQUE (user_id, linkedin_url) constraint to leads if
--      absent (dedupes first so the index can build on dirty data).
--   3. Defensively ensure the weekly_email_queue.contact_id unique index
--      exists, and restore the exception-safe queue trigger.
--   4. Recreate both triggers so re-running this migration self-heals.
--
-- The frontend insert calls need no code change:
--   * insertContact()  — plain INSERT, no ON CONFLICT (1 row).
--   * insertContacts() — upsert on 'email', satisfied by contacts_email_key
--                        (constraint confirmed present on the live project).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Contacts → leads mirror, WITHOUT the constraint-dependent ON CONFLICT.
--    If a duplicate slips through the NOT EXISTS guard, unique_violation is
--    swallowed locally — the ORIGINAL contact INSERT still succeeds.
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
  begin
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
    );
  exception
    when unique_violation then
      null;
  end;
  perform set_config('app.skip_lead_to_contact', 'false', true);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Add the missing UNIQUE (user_id, linkedin_url) constraint on leads if
--    absent, so future INSERTs / ON CONFLICT references also work. Dedupe
--    first (NULLs are not deduped — Postgres treats NULLs as distinct).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.leads'::regclass
      and conname = 'leads_user_id_linkedin_url_key'
  ) then
    delete from public.leads l1
    using public.leads l2
    where l1.linkedin_url is not null
      and l1.user_id is not distinct from l2.user_id
      and l1.linkedin_url = l2.linkedin_url
      and (l1.created_at < l2.created_at
           or (l1.created_at = l2.created_at and l1.id < l2.id));

    alter table public.leads
      add constraint leads_user_id_linkedin_url_key unique (user_id, linkedin_url);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Belt-and-braces: ensure the weekly_email_queue contact_id unique index
--    exists (the queue trigger's ON CONFLICT target).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'weekly_email_queue'
      and indexname = 'weekly_email_queue_contact_id_key'
  ) then
    create unique index weekly_email_queue_contact_id_key
      on public.weekly_email_queue (contact_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Restore the exception-safe queue trigger (from 20260928000000) so the
--    queue insert can never abort the contact insert either.
-- ---------------------------------------------------------------------------
create or replace function public.queue_contact_for_weekly_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  v_email := nullif(trim(coalesce(new.email, '')), '');

  if v_email is null then
    return new;
  end if;

  if exists (
    select 1 from public.weekly_email_queue wq
    where wq.email is not null
      and lower(trim(wq.email)) = lower(v_email)
  ) then
    return new;
  end if;

  begin
    insert into public.weekly_email_queue
      (contact_id, email, full_name, company, designation, industry, status)
    values
      (new.id::text, new.email, coalesce(new.full_name, ''), new.company,
       new.designation, coalesce(new.industry, ''), 'pending')
    on conflict (contact_id) do nothing;
  exception
    when unique_violation then
      null;
  end;

  return new;
end;
$$;

drop trigger if exists contacts_queue_weekly_email_on_insert on public.contacts;
create trigger contacts_queue_weekly_email_on_insert
after insert on public.contacts
for each row
execute function public.queue_contact_for_weekly_email();

drop trigger if exists contacts_mirror_to_leads_on_insert on public.contacts;
create trigger contacts_mirror_to_leads_on_insert
after insert on public.contacts
for each row
execute function public.sync_contact_insert_to_lead();

-- Make PostgREST pick up schema changes immediately.
notify pgrst, 'reload schema';