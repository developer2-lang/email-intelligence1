import { supabase } from '../supabase'

export interface FilterOption {
  id: string
  label: string
  value: string
  is_active: boolean
  sort_order: number
}

export interface ProfileCountOption {
  id: string
  label: string
  value: number
  is_active: boolean
  sort_order: number
}

export interface DepartmentOption {
  id: string
  label: string
  value: string
}

const FILTER_COLUMNS = 'id, label, value, is_active, sort_order'

async function fetchActiveOptions(
  table: string,
): Promise<{ data: FilterOption[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(table)
      .select(FILTER_COLUMNS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    if (error) return { data: [], error: error.message }
    return { data: (data as FilterOption[]) || [], error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : `Failed to fetch ${table}` }
  }
}

export function fetchIndustries(): Promise<{ data: FilterOption[]; error: string | null }> {
  return fetchActiveOptions('industries')
}

export function fetchDesignations(): Promise<{ data: FilterOption[]; error: string | null }> {
  return fetchActiveOptions('designations')
}

export function fetchGeographies(): Promise<{ data: FilterOption[]; error: string | null }> {
  return fetchActiveOptions('geographies')
}

// The public.departments table uses id, label, value, created_at — no is_active
// or sort_order columns. Fetch all departments ordered by label.
export async function fetchDepartments(): Promise<{ data: DepartmentOption[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('departments')
      .select('id, label, value')
      .order('label', { ascending: true })

    if (error) return { data: [], error: error.message }
    return { data: (data as DepartmentOption[]) || [], error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch departments' }
  }
}

export function fetchCompanySizes(): Promise<{ data: FilterOption[]; error: string | null }> {
  return fetchActiveOptions('company_sizes')
}

// number_of_profiles stores integers in `value`, unlike the other filter tables
// which use text. Order fallback sorts numerically, not lexically.
export async function fetchNumberOfProfiles(): Promise<{ data: ProfileCountOption[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('number_of_profiles')
      .select(FILTER_COLUMNS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    if (error) return { data: [], error: error.message }
    const rows: ProfileCountOption[] = (data as ProfileCountOption[]) || []
    return { data: [...rows].sort((a, b) => a.value - b.value), error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch number of profiles' }
  }
}