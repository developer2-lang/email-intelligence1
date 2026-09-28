import { supabase } from '../supabase'

const TABLE = 'apify_scrapers'

export interface ApifyScraper {
  id: string
  name: string
  url: string
  description: string | null
  created_at: string
  updated_at: string
}

export interface ApifyScraperInput {
  name: string
  url: string
  description?: string | null
}

export interface UrlValidationResult {
  valid: boolean
  url: string
  message: string | null
}

/**
 * Validates an Apify link before it is saved.
 * Accepts any absolute http(s) URL; rejects empty values, relative paths and
 * other schemes (mailto:, javascript:, apify://...).
 */
export function validateScraperUrl(value: string): UrlValidationResult {
  const raw = String(value ?? '').trim()
  if (!raw) return { valid: false, url: '', message: 'Apify URL is required' }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      valid: false,
      url: raw,
      message: 'Enter a valid URL, e.g. https://apify.com/username/scraper-name',
    }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, url: raw, message: 'URL must start with http:// or https://' }
  }
  if (!parsed.hostname.includes('.')) {
    return { valid: false, url: raw, message: 'Enter a valid URL, e.g. https://apify.com/username/scraper-name' }
  }

  return { valid: true, url: parsed.toString(), message: null }
}

export function validateScraperName(value: string): string | null {
  return String(value ?? '').trim() ? null : 'Scraper name is required'
}

export async function fetchApifyScrapers(): Promise<{ data: ApifyScraper[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return { data: [], error: error.message }
    return { data: (data as ApifyScraper[]) || [], error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch Apify scrapers' }
  }
}

export async function createApifyScraper(
  input: ApifyScraperInput,
): Promise<{ data: ApifyScraper | null; error: string | null }> {
  try {
    const description = input.description?.trim()
    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        name: input.name.trim(),
        url: input.url.trim(),
        description: description ? description : null,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return { data: null, error: 'This Apify URL has already been saved' }
      }
      return { data: null, error: error.message }
    }
    return { data: data as ApifyScraper, error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to save scraper' }
  }
}

export async function updateApifyScraper(
  id: string,
  input: ApifyScraperInput,
): Promise<{ data: ApifyScraper | null; error: string | null }> {
  try {
    const description = input.description?.trim()
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        name: input.name.trim(),
        url: input.url.trim(),
        description: description ? description : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return { data: null, error: 'This Apify URL has already been saved' }
      }
      return { data: null, error: error.message }
    }
    return { data: data as ApifyScraper, error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to update scraper' }
  }
}

export async function deleteApifyScraper(id: string): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(TABLE).delete().eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete scraper' }
  }
}
