import { supabase } from '../supabase'
import type { Contact, ContactInput, ContactRow } from '../types/contact'

const TABLE = 'contacts'

function toInsertRow(input: ContactInput) {
  return {
    full_name: input.full_name.trim(),
    email: input.email.trim().toLowerCase(),
    company: input.company.trim(),
    designation: input.designation?.trim() || null,
    industry: input.industry?.trim() || null,
    city: input.city?.trim() || null,
    contact_type: input.contact_type || 'New Lead',
    company_category: input.company_category || 'OEM',
    notes: input.notes?.trim() || null,
  }
}

function mapRowToContact(row: ContactRow): Contact {
  return {
    id: String(row.id),
    name: row.full_name || '',
    company: row.company || '',
    email: (row.email || '').toLowerCase().trim(),
    designation: row.designation || '',
    industry: row.industry || '',
    city: row.city || '',
    type: row.contact_type || 'New Lead',
    category: row.company_category || 'OEM',
    notes: row.notes || '',
    lastContacted: '',
    engagement: 0,
    enriched: false,
  }
}

export async function fetchContacts(): Promise<{ data: Contact[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return { data: [], error: error.message }
    const rows = (data as ContactRow[] | null) ?? []
    return { data: rows.map(mapRowToContact), error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch contacts' }
  }
}

export async function fetchAllContactEmails(): Promise<Set<string>> {
  const { data } = await supabase.from(TABLE).select('email')
  return new Set(
    ((data as { email: string | null }[] | null) ?? [])
      .map(c => (c.email || '').toLowerCase().trim())
      .filter(Boolean)
  )
}

export async function insertContact(input: ContactInput): Promise<{ data: Contact | null; error: string | null }> {
  try {
    const { data, error } = await supabase.from(TABLE).insert(toInsertRow(input)).select('*')

    if (error) return { data: null, error: error.message }
    const row = Array.isArray(data) && data.length > 0 ? (data[0] as ContactRow) : null
    return { data: row ? mapRowToContact(row) : null, error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to add contact' }
  }
}

export async function updateContact(id: string, input: ContactInput): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).update(toInsertRow(input)).eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update contact' }
  }
}

export async function deleteContact(id: string): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).delete().eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete contact' }
  }
}

export async function deleteContacts(ids: string[]): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).delete().in('id', ids)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete contacts' }
  }
}

export async function insertContacts(inputs: ContactInput[]): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).upsert(inputs.map(toInsertRow), {
      onConflict: 'email',
      ignoreDuplicates: true,
    })
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to import contacts' }
  }
}

export async function updateContactType(id: string, contactType: string): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).update({ contact_type: contactType }).eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update contact type' }
  }
}
