-- ============================================================================
-- Remove the Contacts → Leads mirror.
-- ============================================================================
-- The Lead Database (public.leads) should ONLY contain leads created by Lead
-- Generation (scrape-leads / enrich-lead / add-lead-manual / find-phone).
--
-- Prior migrations (20260930000000, 20261001000000) attached an AFTER INSERT
-- trigger `contacts_mirror_to_leads_on_insert` on public.contacts that echoed
-- every new contact into public.leads with source_query = 'Contacts',
-- polluting the Lead Database.
--
-- This migration:
--   1. Drops that trigger and its function (sync_contact_insert_to_lead).
--   2. Deletes any leads rows the mirror created (source_query = 'Contacts').
--   3. Leaves the OPPOSITE direction intact (leads → 'lead search' contact,
--      leads_sync_contact_on_insert) and the weekly-email queue trigger
--      (contacts_queue_weekly_email_on_insert).
--
-- Idempotent: safe to (re)run in the Supabase SQL editor.
-- ============================================================================

-- 1. Remove the Contacts → leads mirror trigger + function.
drop trigger if exists contacts_mirror_to_leads_on_insert on public.contacts;
drop function if exists public.sync_contact_insert_to_lead();

-- 2. Clean up leads rows that originated from Contacts.
delete from public.leads
where lower(coalesce(source_query, '')) = 'contacts';

-- 3. Make PostgREST pick up schema changes immediately.
notify pgrst, 'reload schema';