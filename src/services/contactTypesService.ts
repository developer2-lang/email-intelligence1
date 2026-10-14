import { supabase } from '../supabase'

const TABLE = 'contact_types'

export interface ContactType {
  id: string
  name: string
  is_active: boolean
  created_at: string
}

export interface ContactTypeInput {
  name: string
  is_active?: boolean
}

export async function fetchContactTypes(): Promise<{ data: ContactType[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true })

    if (error) return { data: [], error: error.message }
    return { data: (data as ContactType[]) || [], error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch contact types' }
  }
}

export async function fetchAllContactTypes(): Promise<{ data: ContactType[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('name', { ascending: true })

    if (error) return { data: [], error: error.message }
    return { data: (data as ContactType[]) || [], error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch contact types' }
  }
}

export async function createContactType(input: ContactTypeInput): Promise<{ data: ContactType | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ name: input.name.trim(), is_active: input.is_active ?? true })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return { data: null, error: 'A contact list with this name already exists' }
      }
      return { data: null, error: error.message }
    }
    return { data: data as ContactType, error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to create contact list' }
  }
}

export async function updateContactType(id: string, input: Partial<ContactTypeInput>): Promise<{ error: string | null }> {
  try {
    const updates: Record<string, any> = {}
    if (input.name !== undefined) updates.name = input.name.trim()
    if (input.is_active !== undefined) updates.is_active = input.is_active

    const { error } = await supabase.from(TABLE).update(updates).eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update contact list' }
  }
}

export async function deleteContactType(id: string): Promise<{ deletedContacts: number | null; error: string | null }> {
  try {
    const { data: contactType, error: lookupError } = await supabase
      .from(TABLE)
      .select('name')
      .eq('id', id)
      .maybeSingle()
    if (lookupError) return { deletedContacts: null, error: lookupError.message }
    if (!contactType) return { deletedContacts: null, error: 'Contact type not found' }

    const { data: deletedContacts, error: contactsError } = await supabase
      .from('contacts')
      .delete()
      .eq('contact_type', contactType.name)
      .select('id')
    if (contactsError) return { deletedContacts: null, error: contactsError.message }

    const { error: deleteTypeError } = await supabase.from(TABLE).delete().eq('id', id)
    if (deleteTypeError) {
      return {
        deletedContacts: deletedContacts?.length ?? 0,
        error: `Contacts were deleted, but the contact type could not be removed: ${deleteTypeError.message}`,
      }
    }

    return { deletedContacts: deletedContacts?.length ?? 0, error: null }
  } catch (err) {
    return {
      deletedContacts: null,
      error: err instanceof Error ? err.message : 'Failed to delete contact list',
    }
  }
}

export async function checkContactTypeNameExists(name: string, excludeId?: string): Promise<{ exists: boolean; error: string | null }> {
  try {
    let query = supabase.from(TABLE).select('id').ilike('name', name.trim())
    if (excludeId) {
      query = query.neq('id', excludeId)
    }
    const { data, error } = await query.maybeSingle()
    if (error) return { exists: false, error: error.message }
    return { exists: !!data, error: null }
  } catch (err) {
    return { exists: false, error: err instanceof Error ? err.message : 'Failed to check contact list name' }
  }
}

export async function getContactCountByType(contactTypeName: string): Promise<{ count: number; error: string | null }> {
  try {
    const { count, error } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('contact_type', contactTypeName)

    if (error) return { count: 0, error: error.message }
    return { count: count ?? 0, error: null }
  } catch (err) {
    return { count: 0, error: err instanceof Error ? err.message : 'Failed to get contact count' }
  }
}