import { supabase } from '../supabase'

export interface LeadRow {
  id: string
  user_id: string | null
  email: string | null
  phone: string | null
  linkedin_url: string | null
  full_name: string | null
  headline: string | null
  company_name: string | null
  designation: string | null
  role: string | null
  job_title: string | null
  industry: string | null
  geography: string | null
  location: string | null
  source_query: string | null
  phone_attempted: boolean | null
  email_attempted: boolean | null
  created_at: string | null
}

export async function fetchLeads(): Promise<{ data: LeadRow[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .range(0, 9999)   // explicit: never rely on the implicit PostgREST default cap

    if (error) return { data: [], error: error.message }
    return { data: (data as LeadRow[] | null) ?? [], error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch leads' }
  }
}

export async function getLeadCount(): Promise<{ count: number; error: string | null }> {
  try {
    const { count, error } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })

    if (error) return { count: 0, error: error.message }
    return { count: count ?? 0, error: null }
  } catch (err) {
    return { count: 0, error: err instanceof Error ? err.message : 'Failed to get lead count' }
  }
}

export async function updateLead(
  id: string,
  input: {
    full_name?: string
    email?: string | null
    phone?: string | null
    company_name?: string | null
    designation?: string | null
    industry?: string | null
    geography?: string | null
  }
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from('leads').update(input).eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update lead' }
  }
}

export async function deleteLead(id: string): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from('leads').delete().eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete lead' }
  }
}