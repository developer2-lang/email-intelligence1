-- Backfill public.leads.user_id for rows saved before scrape-leads resolved the
-- caller's verified user id.
--
-- Why: the leads RLS policy is `auth.uid() = user_id`
-- (20250918_create_leads_table.sql). For a row with user_id = NULL that
-- comparison yields NULL, which is not true, so the browser can never read it
-- back. Those rows were saved by the Edge Function and reported as successful,
-- but stayed invisible in the UI.
--
-- ── INSTRUCTIONS ────────────────────────────────────────────────────────────
-- 1. Replace REPLACE_WITH_YOUR_USER_UUID below with your own UUID.
--    Supabase dashboard -> Authentication -> Users -> copy the UUID.
-- 2. Run the whole file (Supabase SQL editor, or `supabase db push`).
--
-- Written to run identically in the Supabase SQL editor and via psql: no \set
-- variables and no psql-only syntax. If you forget to replace the placeholder,
-- the ::uuid cast on the INSERT below aborts the script before any row is
-- touched.
--
-- Safe by construction: the UPDATE can only ever set user_id on rows that are
-- currently NULL and whose linkedin_url no other row owns, so it cannot violate
-- unique (user_id, linkedin_url) or unique (linkedin_url), and re-running it is
-- a no-op once the backfill is done.

create temporary table backfill_target (
  user_id uuid primary key
);

insert into backfill_target (user_id)
values ('fdc4275f-4d3a-47de-ae8a-2434ba0e17ac');

-- Safety rail: the target must be a real auth user, otherwise the backfill
-- would hand every orphan row to an id that does not exist.
do $$
begin
  if not exists (select 1 from auth.users where id = (select user_id from backfill_target)) then
    raise exception 'No auth.users row matches backfill_target.user_id — replace the placeholder with your real UUID.';
  end if;
end
$$;

-- 1. Preview. Run this on its own first if you want to see the numbers.
select
  (select count(*) from public.leads where user_id is null) as all_null_rows,
  (select count(*)
     from public.leads l
    where l.user_id is null
      and not exists (
        select 1 from public.leads o
        where o.linkedin_url = l.linkedin_url
          and o.user_id is not null
      )) as will_be_assigned,
  (select count(*)
     from public.leads l
    where l.user_id is null
      and exists (
        select 1 from public.leads o
        where o.linkedin_url = l.linkedin_url
          and o.user_id is not null
      )) as skipped_duplicate_url;

-- 2. Assign the orphaned rows to that user. `distinct on (linkedin_url)` keeps
--    one row per URL (oldest first) so the update cannot trip a unique
--    constraint halfway through, and the NOT EXISTS guard skips URLs another
--    row already owns.
with keeper as (
  select distinct on (l.linkedin_url) l.id
  from public.leads l
  where l.user_id is null
    and not exists (
      select 1 from public.leads o
      where o.linkedin_url = l.linkedin_url
        and o.user_id is not null
    )
  order by l.linkedin_url, l.created_at asc, l.id asc
)
update public.leads l
set user_id = (select user_id from backfill_target)
from keeper k
where l.id = k.id;

-- 3. Leftovers: rows still NULL because another row already owns that
--    linkedin_url. Merging them would break a unique constraint, so these need
--    a manual decision — delete the orphan, or blank the duplicate's URL.
select l.id, l.linkedin_url, l.full_name, l.created_at
from public.leads l
where l.user_id is null
order by l.created_at desc;

-- 4. Verify: still_null should be 0 (or match skipped_duplicate_url above).
select
  count(*) filter (where user_id is null) as still_null,
  count(*) filter (where user_id = (select user_id from backfill_target)) as owned_by_target,
  count(*) as total
from public.leads;

drop table backfill_target;
