-- ============================================================================
-- HTML email template upload — anon Storage access to the existing
-- `email-template` bucket
-- ============================================================================
-- The `templates` table already supports storage-backed templates
-- (template_source = 'storage' + storage_bucket + storage_path) and the PUBLIC
-- `email-template` bucket already exists (seeded in database_data.sql — the
-- built-in 'IUOVA Attractive' template reads its HTML file from it).
--
-- The app has no Supabase Auth users, so every browser request runs as the
-- `anon` role and must be able to upload the HTML file to Storage. Without a
-- policy on storage.objects the upload fails with "new row violates row-level
-- security policy". This migration grants the anon/publishable key
-- INSERT + SELECT + DELETE on THAT bucket only, mirroring the
-- campaign-attachments migration pattern used by the rest of this app. It
-- touches no other bucket and no table or schema.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query) or via the
-- CLI. Idempotent.

-- 1) Make sure the bucket exists (no-op when already present — does not alter
--    existing bucket settings). Public so the browser can read the HTML back
--    via its public URL (same as campaign-attachments).
insert into storage.buckets (id, name, public)
values ('email-template', 'email-template', true)
on conflict (id) do nothing;

-- 2) Storage access for the anon/publishable key used by the browser.
drop policy if exists "email-template insert" on storage.objects;
create policy "email-template insert"
  on storage.objects for insert to anon
  with check (bucket_id = 'email-template');

drop policy if exists "email-template read" on storage.objects;
create policy "email-template read"
  on storage.objects for select to anon
  using (bucket_id = 'email-template');

-- 3) DELETE lets the frontend roll back a stored file when the templates-table
--    insert fails (campaignService uploadEmailTemplate). Scoped to this bucket.
drop policy if exists "email-template delete" on storage.objects;
create policy "email-template delete"
  on storage.objects for delete to anon
  using (bucket_id = 'email-template');
