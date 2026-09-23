-- ============================================================================
-- Weekly auto-email for NEW contacts (one-time welcome send)
-- ============================================================================
-- Sends ONE welcoming email to every NEW contact, automatically, once per
-- week, every Thursday at 8:00 AM IST (= 02:30 UTC). The full flow is split
-- across three pieces:
--
--   1. THIS migration — `public.weekly_email_queue` table + an AFTER INSERT
--      trigger on `public.contacts`. Every brand-new contact that carries a
--      real email address is snapshotted into the queue with status
--      'pending'. Contacts that already existed when this migration is
--      applied are NOT queued (triggers only fire for rows inserted AFTER
--      this migration lands).
--   2. `supabase/functions/process-weekly-queue/index.ts` — Edge Function
--      that drains the pending queue via Gmail SMTP.
--   3. `supabase/weekly-queue-setup.sql` — pg_cron job `weekly-new-contact-email`,
--      Thursday 02:30 UTC (= 08:00 AM IST), that calls that function every Thursday.
--
-- Guarantees:
--   * UNIQUE(contact_id) → one queue row per contact. A contact is never
--     queued twice and never emailed twice (the runner only works on
--     'pending' rows and atomically claims them).
--   * INSERT-only trigger → pre-existing contacts are never retro-queued.
--   * Deleted contacts leave a stale queue row (no hard FK — see contact_id
--     note below); the runner marks orphans 'skipped' instead of emailing.
--
-- contact_id is stored as TEXT on purpose: `public.contacts.id` lives in a
-- table created outside this repo, so its column type is not guaranteed.
-- Storing `NEW.id::text` keeps the trigger insert safe whether contacts.id
-- is uuid or text.
-- ============================================================================

create table if not exists public.weekly_email_queue (
  id             uuid primary key default gen_random_uuid(),
  contact_id     text not null,
  email          text,
  full_name      text,
  company        text,
  designation    text,
  industry       text,
  status         text not null default 'pending'
                 check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts       integer not null default 0,
  queued_at      timestamptz not null default now(),
  attempted_at   timestamptz,
  sent_at        timestamptz,
  next_retry_at  timestamptz,
  error_message  text,
  created_at     timestamptz not null default now()
);

-- Exactly one queue row per contact — the dedupe target for the trigger and
-- the guarantee that a contact is emailed at most once.
create unique index if not exists weekly_email_queue_contact_id_key
  on public.weekly_email_queue (contact_id);

-- Fast lookup of the rows the runner should work on.
create index if not exists weekly_email_queue_pending_idx
  on public.weekly_email_queue (queued_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- INSERT trigger function. Only fires for rows inserted AFTER this migration
-- is applied, so it only ever queues NEW contacts. SECURITY DEFINER lets the
-- write succeed regardless of which role performed the contact insert (anon
-- frontend or service-role edge functions).
-- ---------------------------------------------------------------------------
create or replace function public.queue_contact_for_weekly_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(trim(coalesce(new.email, '')), '');
begin
  -- Only queue rows that can actually receive email.
  if v_email is null or position('@' in v_email) = 0 then
    return new;
  end if;

  insert into public.weekly_email_queue
    (contact_id, email, full_name, company, designation, industry, status)
  values
    (new.id::text, v_email,
     nullif(trim(coalesce(new.full_name, '')), ''),
     nullif(trim(coalesce(new.company, '')), ''),
     new.designation, new.industry,
     'pending')
  on conflict (contact_id) do nothing;

  return new;
end;
$$;

-- Force (re)attach the trigger so re-running this migration is self-healing.
drop trigger if exists contacts_queue_weekly_email_on_insert on public.contacts;
create trigger contacts_queue_weekly_email_on_insert
after insert on public.contacts
for each row
execute function public.queue_contact_for_weekly_email();

-- The frontend reads/removes queue rows with the anon key (same trust model
-- as the rest of the app: `contacts` behaves the same way). Repeat the grant
-- explicitly in case default privileges do not already cover the new table.
grant select, insert, update, delete on public.weekly_email_queue to anon, authenticated, service_role;

-- Make PostgREST pick up the new table/columns immediately.
notify pgrst, 'reload schema';