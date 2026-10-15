import { supabase } from '../supabase'
import type { Contact, ContactInput, ContactRow } from '../types/contact'

const TABLE = 'contacts'

function normalizeLinkedinUrl(url?: string | null): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed.replace(/^\/+/, '')}`
}

function toInsertRow(input: ContactInput): Record<string, unknown> {
  const phone1 = (input.phone_1 ?? input.phone ?? '').trim()
  const phone2 = (input.phone_2 ?? '').trim()
  const email1 = (input.email ?? input.email_1 ?? '').trim().toLowerCase()
  const email2 = (input.email_2 ?? '').trim().toLowerCase()

  return {
    full_name: input.full_name.trim(),
    email: email1 || null,
    email_2: email2 || null,
    company: input.company.trim(),
    designation: input.designation?.trim() || null,
    industry: input.industry?.trim() || null,
    city: input.city?.trim() || null,
    contact_type: input.contact_type || 'New Lead',
    company_category: input.company_category || 'OEM',
    notes: input.notes?.trim() || null,
    phone_1: phone1 || null,
    phone_2: phone2 || null,
    linkedin_url: normalizeLinkedinUrl(input.linkedin_url),
  }
}

function mapRowToContact(row: ContactRow): Contact {
  const primaryEmail = (row.email || row.email_1 || '').toLowerCase().trim()
  const email2 = (row.email_2 || '').toLowerCase().trim()

  return {
    id: String(row.id),
    name: row.full_name || '',
    company: row.company || '',
    email: primaryEmail || email2,
    email_1: primaryEmail || email2,
    email_2: email2,
    designation: row.designation || '',
    industry: row.industry || '',
    city: row.city || '',
    type: row.contact_type || 'New Lead',
    category: row.company_category || 'OEM',
    notes: row.notes || '',
    lastContacted: '',
    engagement: 0,
    enriched: false,
    phone: (row.phone_1 || '').trim(),
    phone_1: (row.phone_1 || '').trim(),
    phone_2: (row.phone_2 || '').trim(),
    linkedin_url: (row.linkedin_url || '').trim(),
    createdAt: row.created_at || '',
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
  const { data } = await supabase.from(TABLE).select('email, email_2')
  const set = new Set<string>()
  for (const row of ((data as { email?: string | null; email_2?: string | null }[] | null) ?? [])) {
    if (row.email) set.add(row.email.toLowerCase().trim())
    if (row.email_2) set.add(row.email_2.toLowerCase().trim())
  }
  return set
}

export async function insertContact(input: ContactInput): Promise<{ data: Contact | null; error: string | null }> {
  try {
    const res = await supabase.from(TABLE).insert(toInsertRow(input)).select('*')

    if (res.error) {
      if (res.error.message.includes('contacts_linkedin_url_key')) {
        return { data: null, error: 'A contact with this LinkedIn URL already exists.' }
      }
      return { data: null, error: res.error.message }
    }
    const row = Array.isArray(res.data) && res.data.length > 0 ? (res.data[0] as ContactRow) : null
    return { data: row ? mapRowToContact(row) : null, error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to add contact' }
  }
}

export async function updateContact(id: string, input: ContactInput): Promise<{ error: string | null }> {
  try {
    const res = await supabase.from(TABLE).update(toInsertRow(input)).eq('id', id)

    return { error: res.error?.message ?? null }
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
    const rows = inputs.map(toInsertRow)

    // Deduplicate any repeated non-empty linkedin_url inside this payload to prevent unique constraint violation
    const seenLinkedin = new Set<string>()
    for (const row of rows) {
      if (row.linkedin_url) {
        const key = String(row.linkedin_url).toLowerCase().trim()
        if (seenLinkedin.has(key)) {
          row.linkedin_url = null
        } else {
          seenLinkedin.add(key)
        }
      }
    }

    const { error } = await supabase.from(TABLE).insert(rows)

    if (error) {
      // If error is duplicate key on linkedin_url (e.g. conflicts with existing row in DB)
      if (error.message.includes('contacts_linkedin_url_key')) {
        const { data: existingRows } = await supabase.from(TABLE).select('linkedin_url').not('linkedin_url', 'is', null)
        const dbLk = new Set((existingRows || []).map((r: any) => String(r.linkedin_url || '').toLowerCase().trim()))
        for (const row of rows) {
          if (row.linkedin_url && dbLk.has(String(row.linkedin_url).toLowerCase().trim())) {
            row.linkedin_url = null
          }
        }
        // Retry insert with conflicts resolved
        const retry = await supabase.from(TABLE).insert(rows)
        if (retry.error) return { error: retry.error.message }
        return { error: null }
      }

      return { error: error.message }
    }

    return { error: null }
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
