-- ============================================================================
-- Fix duplicate emails in the weekly_email_queue AND contacts.
-- ============================================================================
-- Root cause: new contacts with the same email produced one queue row each
-- (e.g. the same address showing 3 Pending + 3 Sent). Requirements:
--   * One queue row per unique email address — no data loss: a 'sent' row
--     always keeps its (earliest) sent_at, a 'pending' group keeps one row.
--   * One contact per unique email address going forward.
--   * Existing duplicates are cleaned automatically on apply.
--   * New duplicate contacts (same email) must NOT be queued again.
--
-- IMPORTANT design note: weekly_email_queue.contact_id is a TEXT column and
-- deliberately has NO foreign key to contacts (contacts.id is uuid), so a
-- contact DELETE does NOT cascade to the queue. This migration therefore
-- dedupes the queue table explicitly (section 1) BEFORE deduping contacts
-- (section 2).
--
-- Keeper rules (applied in order):
--   queue row  per email group: keep 1) 'sent' with the earliest sent_at,
--                               2) 'pending', 3) 'sending',
--                               4) 'failed'/'skipped', newest queued_at.
--   contact    per email group: keep 1) a contact still referenced by a queued
--                               weekly row, 2) a contact with send engagement
--                               (email_logs / campaign_contacts), 3) the newest.
--
-- Idempotent: safe to re-run. Uses partial unique indexes on
-- lower(trim(email)) so NULL/empty emails stay out of the dedupe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Dedupe weekly_email_queue — one row per lowercase email.
--    Keep: sent with earliest sent_at → pending → sending →
--    failed/skipped; resolved by newest queued_at.
-- ---------------------------------------------------------------------------
do $$
begin
  create temp table _wq_dedupe on commit drop as
    select
      id,
      email,
      row_number() over (
        partition by lower(trim(email))
        order by
          case when status = 'sent' then 0 else 1 end,
          case when status = 'sent' then extract(epoch from coalesce(sent_at, queued_at)) end asc nulls last,
          case status when 'pending' then 0 when 'sending' then 1 else 2 end,
          queued_at desc,
          id desc
      ) as rn
    from public.weekly_email_queue
    where email is not null and trim(email) <> '';
end $$;

delete from public.weekly_email_queue q
using _wq_dedupe d
where d.id = q.id and d.rn > 1;

drop table _wq_dedupe;

-- ---------------------------------------------------------------------------
-- 2. Dedupe contacts — one contact per lowercase email.
--    Only contact_list_members FKs contacts(id) (ON DELETE CASCADE); no other
--    table has an FK to contacts, so deletes are safe here. A per-row
--    exception guard still skips (with a NOTICE) any row a future FK blocks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_email   text;
  v_keep    uuid := null;
  v_dup     uuid;
  v_deleted integer := 0;
begin
  for v_email in (
    select email from (
      select lower(trim(email)) as email
      from public.contacts
      where email is not null and trim(email) <> ''
      group by lower(trim(email))
      having count(*) > 1
    ) d
  ) loop
    -- The single keeper for this email group.
    select c.id into v_keep
    from public.contacts c
    where lower(trim(c.email)) = v_email
    order by
      (select case when count(*) > 0 then 0 else 1 end
         from public.weekly_email_queue wq
         where wq.contact_id = c.id::text),
      (select case when count(*) > 0 then 0 else 1 end
         from (select 1 from public.email_logs el where el.contact_id = c.id limit 1) x),
      (select case when count(*) > 0 then 0 else 1 end
         from (select 1 from public.campaign_contacts cc where cc.contact_id = c.id limit 1) y),
      c.created_at desc,
      c.id desc
    limit 1;

    v_keep := coalesce(v_keep, (select c2.id from public.contacts c2
                                where lower(trim(c2.email)) = v_email
                                order by c2.created_at desc, c2.id desc limit 1));

    for v_dup in (
      select c3.id from public.contacts c3
      where lower(trim(c3.email)) = v_email
        and c3.id <> v_keep
    ) loop
      begin
        delete from public.contacts where id = v_dup;
        v_deleted := v_deleted + 1;
      exception
        when others then
          raise notice 'skipping contact % (email %): %', v_dup, v_email, sqlerrm;
      end;
    end loop;
  end loop;

  raise notice 'fix_duplicate_emails: removed % duplicate contacts', v_deleted;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Clean up orphan queue rows whose contact was deleted.
-- ---------------------------------------------------------------------------
delete from public.weekly_email_queue wq
where wq.contact_id is not null
  and not exists (
    select 1 from public.contacts c
    where c.id::text = wq.contact_id
  );

-- ---------------------------------------------------------------------------
-- 4. Unique email indexes (partial, case-insensitive, ignore empty).
--    Prevents duplicate contacts AND duplicate queue rows going forward.
-- ---------------------------------------------------------------------------
create unique index if not exists contacts_email_unique_lower
  on public.contacts (lower(trim(email)))
  where email is not null and trim(email) <> '';

create unique index if not exists weekly_email_queue_email_unique_lower
  on public.weekly_email_queue (lower(trim(email)))
  where email is not null and trim(email) <> '';

-- ---------------------------------------------------------------------------
-- 5. Rewrite the queue trigger: skip contacts whose email is already queued,
--    so re-adding / editing a contact to a queued email never double-queues.
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

-- ---------------------------------------------------------------------------
-- 6. The new contacts email unique index would otherwise break lead → contact
--    mirroring (23505 on a duplicate email). Rewrite the insert trigger to be
--    unique-violation-safe so saving leads never fails.
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
    begin
      insert into public.contacts
        (full_name, email, company, designation, industry, geography, role, job_title,
         phone, contact_type, company_category, linkedin_url)
      values
        (coalesce(new.full_name, ''), coalesce(new.email, ''), coalesce(new.company_name, ''),
         new.designation, new.industry, new.geography, new.role, new.job_title,
         new.phone, 'lead search', 'lead search', new.linkedin_url)
      on conflict (linkedin_url) where linkedin_url is not null do nothing;
    exception
      when unique_violation then
        null; -- another contact already owns this email
    end;
  elsif v_email is not null then
    begin
      insert into public.contacts
        (full_name, email, company, designation, industry, geography, role, job_title,
         phone, contact_type, company_category, linkedin_url)
      select
        coalesce(new.full_name, ''), new.email, coalesce(new.company_name, ''),
        new.designation, new.industry, new.geography, new.role, new.job_title,
        new.phone, 'lead search', 'lead search', new.linkedin_url
      where not exists (
        select 1 from public.contacts c
        where lower(trim(c.email)) = lower(trim(new.email))
      );
    exception
      when unique_violation then
        null;
    end;
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

-- ---------------------------------------------------------------------------
-- Make PostgREST pick up schema changes immediately.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';