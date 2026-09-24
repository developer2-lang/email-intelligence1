-- ============================================================================
-- Add "lead search4" to public.contact_types (Contact Types page row).
-- ============================================================================
-- The Contacts page already renders a "lead search4" tab that mirrors the
-- Lead Database (public.leads) — see LEAD_MIRROR_TAB in src/pages/ContactsTab.tsx.
-- This migration adds the matching reference row so the same name also appears
-- on the Contact Types page list.
--
-- Real table shape: id, name, is_active, created_at.
-- (No status / type / user_id / contact_count columns exist on this table; the
-- Active badge comes from is_active and the Contacts count is computed live
-- from contacts.contact_type in ContactTypesTab.tsx.)
--
-- Idempotent: safe to (re)run in the Supabase SQL editor — it will not insert
-- a duplicate if a row named 'lead search4' (any casing) already exists.
-- ============================================================================

do $$
begin
  if not exists (
    select 1
    from public.contact_types
    where lower(name) = lower('lead search4')
  ) then
    insert into public.contact_types (name, is_active)
    values ('lead search4', true);
  end if;
end $$;

-- Confirm the row (run this SELECT afterwards).
select id, name, is_active, created_at
from public.contact_types
where lower(name) = lower('lead search4');
