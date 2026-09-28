-- Fix the contacts mirror failure: "42P10 - there is no unique or exclusion
-- constraint matching the ON CONFLICT specification".
--
-- Root cause: public.contacts has no NON-partial unique index on linkedin_url.
-- The mirror runs `ON CONFLICT (linkedin_url)`, which carries no index
-- predicate, and Postgres can only infer a PARTIAL unique index when the
-- statement supplies one. PostgREST's on_conflict cannot express that, so the
-- statement is rejected outright — the whole mirror batch fails, and the
-- AFTER INSERT trigger sync_lead_insert_to_contact() hits the same wall.
--
-- The fix is a plain (non-partial) unique index. Postgres permits any number of
-- NULLs in a unique index, so contacts without a linkedin_url are unaffected.
-- A non-partial index is also accepted by the trigger's
-- `on conflict (linkedin_url) where linkedin_url is not null do nothing`,
-- because a full index satisfies any index predicate.

-- 1. Any duplicates left behind must go before the index can be created.
--    Rows referenced by weekly_email_queue are preserved: that queue stores
--    contact_id as loose text with no foreign key, so deleting one would
--    orphan its queue row and silently drop queued emails.
with ranked as (
  select
    c.id,
    row_number() over (
      partition by c.linkedin_url
      order by c.created_at asc, c.id asc
    ) as rn
  from public.contacts c
  where c.linkedin_url is not null
)
delete from public.contacts c
using ranked r
where c.id = r.id
  and r.rn > 1
  and not exists (
    select 1 from public.weekly_email_queue q where q.contact_id = c.id::text
  );

-- 2. If the CREATE below fails, these are the URLs still duplicated by rows
--    that the queue references. Resolve them by hand (merge or blank the
--    linkedin_url on the newer row) and re-run.
select linkedin_url, count(*) as copies,
       array_agg(id order by created_at asc) as contact_ids
from public.contacts
where linkedin_url is not null
group by linkedin_url
having count(*) > 1;

-- 3. Drop any partial index previously created under this name — a
--    `create ... if not exists` would otherwise skip it and leave the mirror
--    broken. Safe: plpgsql function bodies are not dependency-tracked per
--    index, and the whole migration runs in one transaction.
drop index if exists public.contacts_linkedin_url_key;

-- 4. The index the mirror and the trigger both need.
create unique index contacts_linkedin_url_key
  on public.contacts (linkedin_url);

-- 5. PostgREST caches schema; make it reload immediately.
notify pgrst, 'reload schema';
