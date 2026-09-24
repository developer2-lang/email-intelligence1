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

// ─── Custom option persistence ──────────────────────────────────────────────
// Persist "+ Add Custom" values straight into their lookup table so they
// survive reloads/sessions and flow through the same fetchActiveOptions path
// the seeded options use. industries / designations / geographies /
// company_sizes manage sort_order + is_active; departments only has
// value/label.
const SORT_ORDER_TABLES = new Set(['industries', 'designations', 'geographies', 'company_sizes'])

export async function saveCustomOption(
  table: string,
  value: string,
): Promise<{ error: string | null }> {
  const label = value.trim()
  if (!label) return { error: 'Option cannot be empty' }

  const useSortOrder = SORT_ORDER_TABLES.has(table)
  const payload: Record<string, unknown> = { value: label, label }

  try {
    if (useSortOrder) {
      const { data: last, error: lastError } = await supabase
        .from(table)
        .select('sort_order')
        .order('sort_order', { ascending: false })
        .limit(1)
      if (lastError) return { error: lastError.message }
      payload.sort_order = Number(last?.[0]?.sort_order ?? 0) + 1
      payload.is_active = true
    }

    const { error } = await supabase.from(table).insert(payload)
    if (error) {
      // 23505 = unique_violation → the value already exists in the table. The
      // app-side dedupe guard handles the common case; this covers races.
      if (error.code === '23505') return { error: null }
      return { error: error.message }
    }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to save custom option' }
  }
}

export async function removeCustomOption(
  table: string,
  value: string,
): Promise<{ error: string | null }> {
  const label = value.trim()
  if (!label) return { error: 'Option cannot be empty' }
  try {
    const { error } = await supabase.from(table).delete().eq('label', label)
    if (error) return { error: error.message }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to remove custom option' }
  }
}