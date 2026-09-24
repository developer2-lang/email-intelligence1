import { supabase } from '../supabase'

export type CustomFilterCategory = 'designation' | 'industry' | 'geography' | 'role'

export async function fetchCustomFilterOptions(
  categories: CustomFilterCategory[],
): Promise<{ data: Partial<Record<CustomFilterCategory, string[]>>; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('custom_filter_options')
      .select('category, value')
      .in('category', categories)

    if (error) return { data: {}, error: error.message }

    const grouped: Partial<Record<CustomFilterCategory, string[]>> = {}
    for (const row of data ?? []) {
      const category = row.category as CustomFilterCategory
      if (!grouped[category]) grouped[category] = []
      grouped[category].push(row.value)
    }
    return { data: grouped, error: null }
  } catch (err) {
    return { data: {}, error: err instanceof Error ? err.message : 'Failed to fetch custom options' }
  }
}

export async function addCustomFilterOption(
  category: CustomFilterCategory,
  value: string,
): Promise<{ error: string | null }> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { error: 'Not signed in' }

    const { error } = await supabase.from('custom_filter_options').insert({
      user_id: user.id,
      category,
      value,
    })
    if (error) return { error: error.message }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to save custom option' }
  }
}

export async function removeCustomFilterOption(
  category: CustomFilterCategory,
  value: string,
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase
      .from('custom_filter_options')
      .delete()
      .eq('category', category)
      .eq('value', value)
    if (error) return { error: error.message }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to remove custom option' }
  }
}