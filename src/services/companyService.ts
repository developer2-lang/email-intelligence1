import { supabase } from '../supabase'

export interface CompanyMasterRow {
  id: number
  company_name: string
  normalized_name?: string
  created_at?: string
}

export interface FetchCompaniesResult {
  data: string[]
  error: string | null
}

export interface AddCompanyResult {
  data: string | null
  error: string | null
  isDuplicate?: boolean
}

/**
 * Fetch all company names from public.lb_company_master.
 * - Paginates in batches of 1000 to handle Supabase row limits safely.
 * - De-duplicates case-insensitively using a Map.
 * - Returns companies sorted in alphabetical order.
 */
export async function fetchMasterCompanies(): Promise<FetchCompaniesResult> {
  try {
    const pageSize = 1000
    const companyMap = new Map<string, string>()

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('lb_company_master')
        .select('company_name')
        .not('company_name', 'is', null)
        .order('company_name', { ascending: true })
        .range(from, from + pageSize - 1)

      if (error) {
        return { data: [], error: error.message }
      }

      for (const row of data ?? []) {
        const name = (row.company_name ?? '').trim()
        if (name) {
          const key = name.toLowerCase()
          if (!companyMap.has(key)) {
            companyMap.set(key, name)
          }
        }
      }

      if ((data?.length ?? 0) < pageSize) break
    }

    const sortedList = Array.from(companyMap.values()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )

    return { data: sortedList, error: null }
  } catch (err) {
    return {
      data: [],
      error: err instanceof Error ? err.message : 'Failed to fetch companies from lb_company_master',
    }
  }
}

/**
 * Add a custom company to public.lb_company_master.
 * - Trims whitespace and ensures non-empty value.
 * - normalized_name is a GENERATED ALWAYS column in PostgreSQL, so only company_name is inserted.
 * - Handles duplicate unique constraint (code 23505) gracefully.
 */
export async function addCustomCompanyToMaster(rawName: string): Promise<AddCompanyResult> {
  const name = (rawName || '').trim()
  if (!name) {
    return { data: null, error: 'Company name cannot be empty' }
  }

  try {
    const { data, error } = await supabase
      .from('lb_company_master')
      .insert({ company_name: name })
      .select('company_name')
      .maybeSingle()

    if (error) {
      // Postgres error code 23505 = unique_violation (company_master_normalized_name_unique)
      if (error.code === '23505') {
        return { data: name, error: null, isDuplicate: true }
      }
      return { data: null, error: error.message }
    }

    return { data: data?.company_name || name, error: null }
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Failed to add custom company',
    }
  }
}
