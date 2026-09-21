-- ============================================================================
-- Lead Search → Contacts mirror
-- ============================================================================
-- Lets leads saved by the Lead Search page also appear on the Contacts page
-- under the "lead search" contact type / category. Adds the extra columns the
-- mirror uses, a unique index on linkedin_url (dedupe target for runtime
-- upserts), and one-time backfills of leads already saved before this change.
-- Idempotent. Preserves all existing contacts columns.
-- ============================================================================

alter table public.contacts add column if not exists linkedin_url text;
alter table public.contacts add column if not exists phone text;
alter table public.contacts add column if not exists geography text;
alter table public.contacts add column if not exists role text;
alter table public.contacts add column if not exists job_title text;

-- Partial unique index: ignores rows without a URL so multiple NULLs can't collide.
create unique index if not exists contacts_linkedin_url_key
  on public.contacts (linkedin_url)
  where linkedin_url is not null;

-- Backfill leads that were already saved before this migration landed.
insert into public.contacts
  (full_name, email, company, designation, industry, contact_type, company_category,
   linkedin_url, phone, geography, role, job_title)
select
  COALESCE(l.full_name, ''), COALESCE(l.email, ''), COALESCE(l.company_name, ''),
  l.designation, l.industry,
  'lead search', 'lead search',
  l.linkedin_url, l.phone, l.geography, l.role, l.job_title
from public.leads l
where l.linkedin_url is not null
on conflict (linkedin_url) where linkedin_url is not null do nothing;

-- Make PostgREST pick up the new columns immediately.
notify pgrst, 'reload schema';