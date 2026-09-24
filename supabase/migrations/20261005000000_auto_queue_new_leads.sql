-- ============================================================================
-- Auto-queue new leads for weekly welcome email
-- Fires AFTER INSERT on public.leads
-- ============================================================================
-- When a new row lands in public.leads (Lead Generation, manual add, or any
-- other source), snapshot it into public.weekly_email_queue with status
-- 'pending' so the weekly cron (`*/30 2-18 * * 4`) picks it up with the
-- existing send flow. This complements the contacts->queue trigger
-- (contacts_queue_weekly_email_on_insert); leads reached via the contact
-- mirror are never double-queued because both trigger paths dedupe on email.
--
-- Guarantees:
--   * INSERT-only trigger -> pre-existing leads are never retro-queued.
--   * Skips rows with no usable email (null / empty after trim).
--   * Dedupes by email (case/space-insensitive) -> one queue row per address,
--     enforced both by the manual exists() guard and the existing partial
--     unique index weekly_email_queue_email_unique_lower (unique_violation is
--     swallowed so the ORIGINAL lead insert never aborts).
--   * contact_id is required (NOT NULL) and unique — namespaced as
--     'lead-<uuid>' so it can never collide with a real contact's id::text.
--   * SECURITY DEFINER -> queues regardless of the inserting role (anon
--     frontend or service-role edge function).
--   * No DML on existing queue rows — untouched.
-- Idempotent: safe to re-run (create or replace function + drop/create trigger).
-- ============================================================================

create or replace function public.queue_lead_for_weekly_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  -- Normalize email
  v_email := nullif(trim(coalesce(new.email, '')), '');

  -- Skip if no email
  if v_email is null then
    return new;
  end if;

  -- Skip if already queued (dedupe by email)
  if exists (
    select 1 from public.weekly_email_queue wq
    where wq.email is not null
      and lower(trim(wq.email)) = lower(v_email)
  ) then
    return new;
  end if;

  -- Insert into weekly queue
  begin
    insert into public.weekly_email_queue
      (contact_id, email, full_name, company, designation, industry, status, queued_at)
    values
      ('lead-' || new.id::text,
       v_email,
       coalesce(new.full_name, ''),
       new.company_name,
       new.designation,
       new.industry,
       'pending',
       now());
  exception
    when unique_violation then
      -- Ignore duplicates gracefully (email unique index or contact_id race)
      null;
  end;

  return new;
end;
$$;

-- Attach trigger to leads table
drop trigger if exists leads_queue_weekly_email_on_insert on public.leads;
create trigger leads_queue_weekly_email_on_insert
after insert on public.leads
for each row
execute function public.queue_lead_for_weekly_email();

-- Reload PostgREST schema cache
notify pgrst, 'reload schema';