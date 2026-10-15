import { useState, useEffect, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { supabase } from '../supabase'
import {
  fetchCompanySizes,
  fetchDepartments,
  fetchDesignations,
  fetchGeographies,
  fetchIndustries,
  fetchNumberOfProfiles,
  fetchStates,
  removeCustomOption,
  saveCustomOption,
  resolveCountryCode,
  type FilterOption,
  type ProfileCountOption,
} from '../services/filterService'
import SearchableSelect from '../components/SearchableSelect'
import { fetchMasterCompanies, addCustomCompanyToMaster } from '../services/companyService'
import { queueContactsForWeeklyEmail } from '../services/weeklyQueueService'

interface Lead {
  id: string
  name?: string
  email?: string
  phone?: string
  linkedinUrl?: string
  full_name?: string
  company_name?: string
  job_title?: string
  designation?: string
  role?: string
  industry?: string
  geography?: string
  phone_attempted?: boolean
  email_attempted?: boolean
}

interface Filters {
  name: string
  company: string
  industry: string
  designation: string
  geography: string
  state: string
  role: string
  companySize: string
  maxItems: number
}

const DEFAULT_FILTERS: Filters = { name: '', company: '', industry: '', designation: '', geography: '', state: '', role: '', companySize: '', maxItems: 5 }

function mergeUnique(lists: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const opt of list) {
      const value = opt.trim()
      const key = value.toLowerCase()
      if (value && !seen.has(key)) {
        seen.add(key)
        out.push(value)
      }
    }
  }
  return out
}

function companyFromDesignation(designation?: string): string | null {
  if (!designation) return null

  const candidates: string[] = []

  // Prefer the explicit "@ Company" signal when present (e.g. "CEO @ Acme Corp | Investor")
  const atParts = designation.split('@')
  if (atParts.length > 1) {
    const after = atParts[atParts.length - 1].split('|')[0].trim()
    if (after) candidates.push(after)
  }

  // Otherwise take the LAST "|" segment (e.g. "Partner | GBS & GCC Advisory | Everest Group" -> "Everest Group")
  const pipeSegments = designation.split('|').map((s) => s.trim()).filter(Boolean)
  const lastSegment = pipeSegments[pipeSegments.length - 1]
  if (lastSegment) candidates.push(lastSegment)

  for (const candidate of candidates) {
    if (candidate.length >= 2 && !candidate.includes('|') && !candidate.includes('@')) {
      return candidate
    }
  }
  return null
}

function leadMatchesName(lead: Lead, nameQuery: string): boolean {
  if (!nameQuery || !nameQuery.trim()) return true
  const q = nameQuery.trim().toLowerCase()
  const nameVal = (lead.full_name || lead.name || '').trim().toLowerCase()
  if (!nameVal) return false
  if (nameVal.includes(q)) return true
  const tokens = q.split(/\s+/).filter(Boolean)
  return tokens.length > 0 && tokens.every((t) => nameVal.includes(t))
}

const COMPANY_STOPWORDS = new Set([
  'ltd', 'limited', 'pvt', 'private', 'inc', 'incorporated', 'corp', 'corporation',
  'llc', 'co', 'company', 'group', 'holdings', 'enterprises', 'solutions', 'technologies', 'services', 'jv', 'between'
])

function cleanCompanyTokens(str: string): string[] {
  return str
    .toLowerCase()
    .replace(/[()[\]{},.;:/\-_+&|~`!@#$%^*=]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !COMPANY_STOPWORDS.has(t))
}

function leadMatchesCompany(lead: Lead, companyQuery: string): boolean {
  if (!companyQuery || !companyQuery.trim()) return true
  const q = companyQuery.trim().toLowerCase()
  const compVal = (
    lead.company_name ||
    companyFromDesignation(lead.designation) ||
    lead.job_title ||
    lead.designation ||
    ''
  ).trim().toLowerCase()
  if (!compVal) return false

  // 1. Direct substring match
  if (compVal.includes(q)) return true

  // 2. Tokenized match (e.g. "Hindware Limited" matches "JV between Hindware Home Innovation Limited")
  const queryTokens = cleanCompanyTokens(companyQuery)
  if (queryTokens.length > 0 && queryTokens.some((t) => compVal.includes(t))) {
    return true
  }

  // 3. Lead tokens present in query
  const leadTokens = cleanCompanyTokens(compVal)
  if (leadTokens.length > 0 && leadTokens.some((t) => q.includes(t))) {
    return true
  }

  return false
}

function hasPhoneValue(phone?: string): boolean {
  if (!phone) return false
  const normalized = phone.trim().toUpperCase()
  return normalized !== '' && normalized !== 'EMPTY' && normalized !== 'NULL'
}

// Strip the job title + company out of a scraped designation so the DESIGNATION
// column doesn't duplicate COMPANY / JOB TITLE. Removes connectors ("@ ", " at ",
// " | ", " - ", " — ") and collapses double separators. Returns '' when nothing
// is left (renders as "—").
function cleanDesignation(
  designation?: string,
  jobTitle?: string,
  companyName?: string,
): string {
  if (!designation) return ''
  let d = designation

  // 1. Remove the job_title prefix (case-insensitive)
  const jt = jobTitle?.trim()
  if (jt && d.toLowerCase().startsWith(jt.toLowerCase())) {
    d = d.slice(jt.length)
  }

  // 2. Remove the company_name wherever it appears (case-insensitive)
  const cn = companyName?.trim()
  if (cn) {
    const idx = d.toLowerCase().indexOf(cn.toLowerCase())
    if (idx !== -1) d = d.slice(0, idx) + d.slice(idx + cn.length)
  }

  // 3. Normalize connectors to a single "|", collapse runs, drop empty segments
  d = d
    .replace(/@/g, '|')
    .replace(/\bat\b/gi, '|')
    .replace(/\s+-\s+/g, '|')
    .replace(/\s*—\s*/g, '|')
    .replace(/\s*\|\s*/g, '|')
    .replace(/\|+/g, '|')
    .split('|')
    .map((s) => s.trim())
    .map((s) => s.replace(/^[:;,.\-–—·•]+/, '').replace(/[:;.\-–—·•]+$/, ''))
    .filter(Boolean)
    .join(' | ')

  return d.trim()
}

function leadFromRow(row: any): Lead {
  const resolvedName = row.name || row.full_name || ''
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    name: resolvedName,
    full_name: resolvedName,
    company_name: row.company_name,
    job_title: row.job_title || '',
    designation: row.designation,
    role: row.role || '',
    industry: row.industry,
    geography: row.geography,
    phone_attempted: row.phone_attempted === true,
    email_attempted: row.email_attempted === true,
  }
}

import type { TabKey } from '../types'

function loadCustomValues(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

interface LeadSearchProps {
  onNavigate?: (tab: TabKey) => void
  onBack?: () => void
}

export default function LeadSearch({ onNavigate, onBack }: LeadSearchProps = {}) {
  const [filters, setFilters] = useState<Filters>(() => {
    const saved = localStorage.getItem('leadSearchFilters')
    return saved ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) } : DEFAULT_FILTERS
  })
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [searchResultLeadIds, setSearchResultLeadIds] = useState<Set<string> | null>(null)
  const [enriching, setEnriching] = useState<Set<string>>(new Set())
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [fetchingPhoneId, setFetchingPhoneId] = useState<string | null>(null)
  const [emailNotFoundIds, setEmailNotFoundIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('emailNotFoundIds')
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>()
    } catch { return new Set<string>() }
  })
  const [phoneNotFoundIds, setPhoneNotFoundIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('phoneNotFoundIds')
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>()
    } catch { return new Set<string>() }
  })
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [tableSearch, setTableSearch] = useState('')
  const [tierAttempts, setTierAttempts] = useState<any[]>([])
  const [showTierDebug, setShowTierDebug] = useState(false)
  const [apifyError, setApifyError] = useState<string | null>(null)
  const [isEmailLimitReached, setIsEmailLimitReached] = useState(false)
  const [emailLimitMessage, setEmailLimitMessage] = useState<string>('')
  const [emailLimitRunUrl, setEmailLimitRunUrl] = useState<string>('https://console.apify.com/actors/bfH8Ermocz8oYKQVO/runs')
  const [phoneLimitRunUrl, setPhoneLimitRunUrl] = useState<string>('https://console.apify.com/actors/J9mf98b4CIZpW72Ue/runs')
  const [lookupLogs, setLookupLogs] = useState<Record<string, { message: string; runUrl?: string }>>(() => {
    try {
      const raw = localStorage.getItem('leadLookupLogs')
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  })
  const [limitModal, setLimitModal] = useState<{
    isOpen: boolean
    title: string
    message: string
    type: 'email' | 'phone' | 'scraper'
    runUrl?: string
    leadToRetry?: Lead
  }>({
    isOpen: false,
    title: '',
    message: '',
    type: 'email',
  })

  const [companySizes, setCompanySizes] = useState<FilterOption[]>([])
  const [profileCounts, setProfileCounts] = useState<ProfileCountOption[]>([])
  const [filterMetaLoading, setFilterMetaLoading] = useState(true)
  const [filterMetaError, setFilterMetaError] = useState<string | null>(null)

  const [industryOptions, setIndustryOptions] = useState<string[]>([])
  const [companyOptions, setCompanyOptions] = useState<string[]>([])
  const [companyLoading, setCompanyLoading] = useState(false)
  const [companyError, setCompanyError] = useState<string | null>(null)
  const [designationOptions, setDesignationOptions] = useState<string[]>([])
  const [geographyOptions, setGeographyOptions] = useState<string[]>([])
  const [stateOptions, setStateOptions] = useState<string[]>([])
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([])

  const [customIndustries, setCustomIndustries] = useState<string[]>(() => loadCustomValues('custom_industries'))
  const [customCompanies, setCustomCompanies] = useState<string[]>(() => loadCustomValues('custom_companies'))
  const [customDesignations, setCustomDesignations] = useState<string[]>(() => loadCustomValues('custom_designations'))
  const [customGeographies, setCustomGeographies] = useState<string[]>(() => loadCustomValues('custom_geographies'))
  const [customStates, setCustomStates] = useState<string[]>(() => loadCustomValues('custom_states'))
  const [customRoles, setCustomRoles] = useState<string[]>([])
  const [customCompanySizes, setCustomCompanySizes] = useState<string[]>([])

  useEffect(() => {
    localStorage.setItem('leadSearchFilters', JSON.stringify(filters))
  }, [filters])

  useEffect(() => {
    localStorage.setItem('phoneNotFoundIds', JSON.stringify([...phoneNotFoundIds]))
  }, [phoneNotFoundIds])

  useEffect(() => {
    localStorage.setItem('emailNotFoundIds', JSON.stringify([...emailNotFoundIds]))
  }, [emailNotFoundIds])

  useEffect(() => {
    try {
      localStorage.setItem('leadLookupLogs', JSON.stringify(lookupLogs))
    } catch {}
  }, [lookupLogs])

  useEffect(() => {
    localStorage.setItem('custom_industries', JSON.stringify(customIndustries))
  }, [customIndustries])

  useEffect(() => {
    localStorage.setItem('custom_companies', JSON.stringify(customCompanies))
  }, [customCompanies])

  useEffect(() => {
    localStorage.setItem('custom_designations', JSON.stringify(customDesignations))
  }, [customDesignations])

  useEffect(() => {
    localStorage.setItem('custom_geographies', JSON.stringify(customGeographies))
  }, [customGeographies])

  useEffect(() => {
    localStorage.setItem('custom_states', JSON.stringify(customStates))
  }, [customStates])

  // Load every filter dropdown from its master table on mount so the options
  // always reflect the database (single source of truth), never hardcoded
  // lists. Companies are loaded dynamically from public.lb_company_master.
  useEffect(() => {
    let cancelled = false
    setCompanyLoading(true)
    setCompanyError(null)
    ;(async () => {
      const [ind, des, geo, dept, cs, np, co] = await Promise.all([
        fetchIndustries(),
        fetchDesignations(),
        fetchGeographies(),
        fetchDepartments(),
        fetchCompanySizes(),
        fetchNumberOfProfiles(),
        fetchMasterCompanies(),
      ])
      if (cancelled) return
      setIndustryOptions(ind.data.map((o) => o.label))
      if (co.error) {
        setCompanyError(co.error)
      } else {
        setCompanyOptions(co.data)
      }
      setCompanyLoading(false)
      setDesignationOptions(des.data.map((o) => o.label))
      setGeographyOptions(
        mergeUnique([geo.data.filter((o) => o.value !== 'all').map((o) => o.label)]),
      )
      setDepartmentOptions(dept.data.map((o) => o.label))
      setCompanySizes(cs.data)
      setProfileCounts(np.data)
      setFilterMetaError(
        [ind, des, geo, dept, cs, np].map((r) => r.error).filter(Boolean).join('; ') || null,
      )
      setFilterMetaLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Dependent State dropdown: Loads only states for the selected Geography.
  // If Geography is empty, clear stateOptions and reset any selected state.
  useEffect(() => {
    let cancelled = false
    const selectedGeography = filters.geography

    if (!selectedGeography || !selectedGeography.trim()) {
      setStateOptions([])
      if (filters.state) {
        setFilters((prev) => ({ ...prev, state: '' }))
      }
      return
    }

    const countryCode = resolveCountryCode(selectedGeography)
    console.log('Selected Geography:', selectedGeography)
    console.log('Country code:', countryCode)

    ;(async () => {
      const res = await fetchStates(countryCode, selectedGeography)
      if (cancelled) return
      if (res.error) {
        console.error('Failed to fetch states for', selectedGeography, res.error)
        setStateOptions([])
        return
      }
      const states = res.data.map((s) => s.name).filter(Boolean)
      console.log('Filtered states:', states)
      setStateOptions(states)
      setFilters((prev) => {
        if (prev.state && !states.includes(prev.state)) {
          return { ...prev, state: '' }
        }
        return prev
      })
    })()

    return () => {
      cancelled = true
    }
  }, [filters.geography])

  // Single source of truth for the table. The mount fetch and the post-search
  // refresh MUST use the identical query, otherwise the row count can shrink or
  // stall depending on which one ran last.
  const fetchLeadsFromDb = useCallback(async () => {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .range(0, 9999) // explicit: never rely on the implicit PostgREST max-rows cap
    if (error) throw error
    return (data ?? []).map(leadFromRow)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const fetched = await fetchLeadsFromDb()
        setLeads(fetched)
        setEmailNotFoundIds((prev) => {
          const next = new Set(prev)
          for (const l of fetched) {
            if (l.email_attempted && !l.email) {
              if (l.id) next.add(l.id)
              if (l.linkedinUrl) next.add(l.linkedinUrl)
            }
          }
          return next
        })
        setPhoneNotFoundIds((prev) => {
          const next = new Set(prev)
          for (const l of fetched) {
            if (l.phone_attempted && !hasPhoneValue(l.phone)) {
              if (l.id) next.add(l.id)
              if (l.linkedinUrl) next.add(l.linkedinUrl)
            }
          }
          return next
        })
      } catch {
        // Leave the table empty; the search button reports its own errors.
      }
    })()
  }, [fetchLeadsFromDb])

  const handleSelect = (key: keyof Filters, value: string) => {
    if (key === 'geography') {
      // When Geography changes:
      // 1. Clear currently selected State immediately
      // 2. Set new Geography
      setFilters((prev) => ({
        ...prev,
        geography: value,
        state: '',
      }))
    } else {
      setFilters((prev) => ({ ...prev, [key]: value }))
    }
  }

  const addCustomIndustry = (value: string) => {
    const v = value.trim()
    if (!v) return
    if (
      customIndustries.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      industryOptions.some((x) => x.toLowerCase() === v.toLowerCase())
    ) {
      return
    }
    setCustomIndustries((prev) => [...prev, v])
    void saveCustomOption('industries', v).then((res) => {
      setNotice(
        res.error ? `Could not save "${v}": ${res.error}` : `Saved "${v}" as a custom industry`,
      )
    })
  }
  const removeCustomIndustry = (value: string) => {
    setCustomIndustries((prev) => prev.filter((x) => x !== value))
    void removeCustomOption('industries', value).then((res) => {
      if (res.error) setNotice(`Could not remove "${value}": ${res.error}`)
    })
  }

  const addCustomDesignation = (value: string) => {
    const v = value.trim()
    if (!v) return
    if (
      customDesignations.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      designationOptions.some((x) => x.toLowerCase() === v.toLowerCase())
    ) {
      return
    }
    setCustomDesignations((prev) => [...prev, v])
    void saveCustomOption('designations', v).then((res) => {
      setNotice(
        res.error ? `Could not save "${v}": ${res.error}` : `Saved "${v}" as a custom designation`,
      )
    })
  }
  const removeCustomDesignation = (value: string) => {
    setCustomDesignations((prev) => prev.filter((x) => x !== value))
    void removeCustomOption('designations', value).then((res) => {
      if (res.error) setNotice(`Could not remove "${value}": ${res.error}`)
    })
  }

  const addCustomGeography = (value: string) => {
    const v = value.trim()
    if (!v) return
    if (
      customGeographies.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      geographyOptions.some((x) => x.toLowerCase() === v.toLowerCase())
    ) {
      return
    }
    setCustomGeographies((prev) => [...prev, v])
    void saveCustomOption('geographies', v).then((res) => {
      setNotice(
        res.error ? `Could not save "${v}": ${res.error}` : `Saved "${v}" as a custom geography`,
      )
    })
  }
  const removeCustomGeography = (value: string) => {
    setCustomGeographies((prev) => prev.filter((x) => x !== value))
    void removeCustomOption('geographies', value).then((res) => {
      if (res.error) setNotice(`Could not remove "${value}": ${res.error}`)
    })
  }

  const addCustomState = (value: string) => {
    const v = value.trim()
    if (!v) return
    if (
      customStates.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      stateOptions.some((x) => x.toLowerCase() === v.toLowerCase())
    ) {
      return
    }
    setCustomStates((prev) => [...prev, v])
  }
  const removeCustomState = (value: string) => {
    setCustomStates((prev) => prev.filter((x) => x !== value))
  }

  const addCustomRole = (value: string) => {
    const v = value.trim()
    if (!v) return
    if (
      departmentOptions.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      customRoles.some((x) => x.toLowerCase() === v.toLowerCase())
    ) {
      return
    }
    setCustomRoles((prev) => [...prev, v])
    void saveCustomOption('departments', v).then((res) => {
      setNotice(res.error ? `Could not save "${v}": ${res.error}` : `Saved "${v}" as a department`)
    })
  }
  const removeCustomRole = (value: string) => {
    setCustomRoles((prev) => prev.filter((x) => x !== value))
    void removeCustomOption('departments', value).then((res) => {
      if (res.error) setNotice(`Could not remove "${value}": ${res.error}`)
    })
  }

  const addCustomCompanySize = (value: string) => {
    const v = value.trim()
    if (!v) return
    if (
      customCompanySizes.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      companySizes.some((n) => n.label.toLowerCase() === v.toLowerCase())
    ) {
      return
    }
    setCustomCompanySizes((prev) => [...prev, v])
    void saveCustomOption('company_sizes', v).then((res) => {
      setNotice(
        res.error ? `Could not save "${v}": ${res.error}` : `Saved "${v}" as a custom company size`,
      )
    })
  }
  const removeCustomCompanySize = (value: string) => {
    setCustomCompanySizes((prev) => prev.filter((x) => x !== value))
    void removeCustomOption('company_sizes', value).then((res) => {
      if (res.error) setNotice(`Could not remove "${value}": ${res.error}`)
    })
  }

  const addCustomCompany = async (value: string) => {
    const name = value.trim()
    if (!name) return

    // Immediately select the custom company and save to custom options
    handleSelect('company', name)
    setCustomCompanies((prev) => mergeUnique([[...prev, name]]))

    // Case-insensitive check against already loaded company list
    const existing = companyOptions.find((company) => company.toLowerCase() === name.toLowerCase())
    if (existing) {
      handleSelect('company', existing)
      setNotice(`Company "${existing}" selected.`)
      return
    }

    setNotice(`Selected company "${name}".`)

    // Attempt to persist to master table in background without blocking selection
    void addCustomCompanyToMaster(name).then(async (res) => {
      if (!res.error) {
        const refreshed = await fetchMasterCompanies()
        if (!refreshed.error && refreshed.data.length > 0) {
          setCompanyOptions(refreshed.data)
        }
      }
    })
  }

  const removeCustomCompany = (value: string) => {
    setCustomCompanies((prev) => prev.filter((company) => company !== value))
  }

  const handleBack = () => {
    if (onBack) {
      onBack()
    } else if (onNavigate) {
      onNavigate('lead-database')
    } else if (window.history.length > 1) {
      window.history.back()
    }
  }

  const handleResetSearch = () => {
    setLeads([])
    setSearched(false)
    setSearchResultLeadIds(null)
    setError(null)
    setNotice(null)
    setTableSearch('')
  }

  const handleSearch = async () => {
    setLoading(true)
    setError(null)
    setApifyError(null)
    setNotice(null)
    setSearched(true)
    setTierAttempts([])
    const searchedQuery =
      [filters.name, filters.company, filters.designation, filters.industry, filters.role, filters.state].filter(Boolean).join(' ') || 'CEO'

    try {
      // 1. Fetch latest stored leads from Supabase database
      let freshLeads: Lead[] = []
      try {
        freshLeads = await fetchLeadsFromDb()
      } catch (dbErr: any) {
        console.warn('[LeadSearch] fetchLeadsFromDb failed:', dbErr?.message)
      }

      // 2. Call Apify lead-search integration with tiered fallback
      let data: any = null
      const session = (await supabase.auth.getSession()).data.session

      // Determine clean LinkedIn location: pick State if chosen, otherwise mapped Geography (never combine with comma/space)
      const COUNTRY_MAP: Record<string, string> = {
        USA: 'United States',
        US: 'United States',
        UK: 'United Kingdom',
        IN: 'India',
        CA: 'Canada',
        AU: 'Australia',
      }
      let selectedLocation: string | null = null
      if (filters.state && filters.state.trim()) {
        selectedLocation = filters.state.trim()
      } else if (filters.geography && filters.geography.trim()) {
        const geo = filters.geography.trim()
        selectedLocation = COUNTRY_MAP[geo.toUpperCase()] || geo
      }
      const searchLocations = selectedLocation ? [selectedLocation] : []

      const searchPayload = {
        filters: {
          ...filters,
          name: filters.name?.trim(),
          locations: searchLocations,
        },
        locations: searchLocations,
        userId: session?.user?.id,
      }

      // Call the backend API route using Apify Client SDK
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (session?.access_token) {
          headers['Authorization'] = `Bearer ${session.access_token}`
        }
        const res = await fetch('/api/leads/search', {
          method: 'POST',
          headers,
          body: JSON.stringify(searchPayload),
        })
        if (res.ok) {
          data = await res.json()
        } else {
          const errData = await res.json().catch(() => null)
          throw new Error(errData?.error || `API returned status ${res.status}`)
        }
      } catch (apiErr: any) {
        console.warn('[LeadSearch] Backend /api/leads/search call failed, falling back to Supabase function:', apiErr.message)
        const edgeRes = await supabase.functions.invoke('scrape-leads', {
          body: searchPayload,
        })
        if (edgeRes.error) throw edgeRes.error
        data = edgeRes.data
      }

      if (!data?.success) throw new Error(data?.error || 'Search failed')

      if (Array.isArray(data.tierAttempts)) {
        setTierAttempts(data.tierAttempts)
      }
      if (data.apifyError) {
        setApifyError(data.apifyError)
      }

      const saved = Number(data.savedCount) || 0

      // Map leads directly returned in response payload (Name, Job Title, Email, LinkedIn URL)
      const returnedLeads: Lead[] = Array.isArray(data.leads || data.data)
        ? (data.leads || data.data).map((l: any) => ({
            id: l.id || `lead-${Date.now()}-${Math.random()}`,
            name: l.name || l.full_name,
            email: l.email || undefined,
            phone: l.phone || undefined,
            linkedinUrl: l.linkedinUrl || l.linkedin_url,
            full_name: l.full_name || l.name,
            company_name: l.company_name,
            job_title: l.job_title,
            designation: l.designation,
            role: l.role,
            industry: l.industry,
            geography: l.geography,
          }))
        : []

      // Re-fetch stored leads from database if available
      try {
        freshLeads = await fetchLeadsFromDb()
      } catch {
        // Keep whatever freshLeads was
      }

      // Merge returned leads with DB leads, prioritizing freshly returned leads
      const mergedMap = new Map<string, Lead>()
      for (const l of returnedLeads) {
        const key = l.linkedinUrl || l.id
        mergedMap.set(key, l)
      }
      for (const l of freshLeads) {
        const key = l.linkedinUrl || l.id
        if (!mergedMap.has(key)) {
          mergedMap.set(key, l)
        } else {
          mergedMap.set(key, { ...l, ...mergedMap.get(key) })
        }
      }

      const returnedKeys = new Set<string>()
      for (const l of returnedLeads) {
        if (l.id) returnedKeys.add(l.id.toLowerCase())
        if (l.linkedinUrl) returnedKeys.add(l.linkedinUrl.toLowerCase())
      }
      setSearchResultLeadIds(returnedKeys.size > 0 ? returnedKeys : null)

      const finalLeads = Array.from(mergedMap.values())
      if (finalLeads.length > 0) {
        setLeads(finalLeads)
      } else if (returnedLeads.length > 0) {
        setLeads(returnedLeads)
      }

      // Automatically queue newly scraped leads that have an email into weekly queue
      const withEmail = (finalLeads.length > 0 ? finalLeads : returnedLeads).filter((l) => l.email && l.email.trim())
      if (withEmail.length > 0) {
        void queueContactsForWeeklyEmail(
          withEmail.map((l) => ({
            id: l.id,
            contact_id: `lead-${l.id}`,
            email: l.email,
            full_name: l.full_name || '',
            company: l.company_name || '',
            designation: l.designation,
            industry: l.industry,
          }))
        )
      }

      const matchingFinal = finalLeads.filter((l) => {
        const idKey = (l.id || '').toLowerCase()
        const urlKey = (l.linkedinUrl || '').toLowerCase()
        const isFromSearch = (idKey && returnedKeys.has(idKey)) || (urlKey && returnedKeys.has(urlKey))
        if (isFromSearch) return true
        if (filters.name && !leadMatchesName(l, filters.name)) return false
        if (filters.company && !leadMatchesCompany(l, filters.company)) return false
        return true
      })

      if (data.apifyError) {
        setApifyError(data.apifyError)
        setNotice(data.apifyError)
      } else if (data.tierDescription) {
        setNotice(data.tierDescription)
      } else if (saved > 0) {
        setNotice(`${saved} new lead${saved === 1 ? '' : 's'} saved`)
      } else if (matchingFinal.length > 0) {
        setNotice(`Found ${matchingFinal.length} matching lead${matchingFinal.length === 1 ? '' : 's'} for "${searchedQuery}"`)
      } else if (returnedLeads.length > 0) {
        setNotice(`Found ${returnedLeads.length} lead${returnedLeads.length === 1 ? '' : 's'} for "${searchedQuery}"`)
      } else {
        setNotice(data.message || `No leads found for "${searchedQuery}" across search tiers`)
      }
    } catch (e: any) {
      setError(e?.message || 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  const handleClearSavedLeads = async () => {
    const { error } = await supabase
      .from('leads')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')
    if (!error) setLeads([])
  }

  const handleEnrichLead = async (lead: Lead, forceRetry = false) => {
    if (!lead.id) return

    // If limit was already reached, show popup immediately when clicking Find Email
    if (isEmailLimitReached && !forceRetry) {
      setLimitModal({
        isOpen: true,
        title: 'Email Limit Reached',
        message: emailLimitMessage || 'Apify Email Scraper limit reached. Upgrade to a paid Apify plan to continue.',
        type: 'email',
        runUrl: emailLimitRunUrl,
        leadToRetry: lead,
      })
      return
    }

    // Clear any previous "not found" / error state so Fetching... shows immediately
    setEmailNotFoundIds((prev) => { const s = new Set(prev); s.delete(lead.id); if (lead.linkedinUrl) s.delete(lead.linkedinUrl); return s })
    setRowErrors((prev) => { const next = { ...prev }; delete next[`email_${lead.id}`]; return next })
    setEnriching((prev) => new Set(prev).add(lead.id))
    try {
      const { data, error } = await supabase.functions.invoke('enrich-lead', {
        body: { leadId: lead.id, linkedinUrl: lead.linkedinUrl },
      })
      if (error) {
        let errText = error.message || 'Email lookup failed'
        let isLimit = false
        let errorRunUrl = 'https://console.apify.com'
        try {
          if ('context' in error && typeof (error as any).context?.json === 'function') {
            const ctxJson = await (error as any).context.json()
            if (ctxJson?.apifyError || ctxJson?.reason || ctxJson?.error) {
              errText = ctxJson.apifyError || ctxJson.reason || ctxJson.error
            }
            if (ctxJson?.isLimit) isLimit = true
            if (ctxJson?.runUrl) errorRunUrl = ctxJson.runUrl
          }
        } catch {}
        if (!isLimit) {
          isLimit = /limit|quota|credit|reach|exceed|payment|usage/i.test(errText)
        }
        if (isLimit) {
          const limitMsg = `Email Scraper limit reached: ${errText}`
          setIsEmailLimitReached(true)
          setEmailLimitMessage(errText)
          setEmailLimitRunUrl(errorRunUrl)
          setApifyError(limitMsg)
          setRowErrors((prev) => ({ ...prev, [`email_${lead.id}`]: limitMsg }))
          setLimitModal({
            isOpen: true,
            title: 'Email Limit Reached',
            message: errText,
            type: 'email',
            runUrl: errorRunUrl,
            leadToRetry: lead,
          })
        } else {
          setRowErrors((prev) => ({ ...prev, [`email_${lead.id}`]: errText }))
        }
        return
      }

      if (!data?.success) {
        const errorMsg = data?.apifyError || data?.reason || data?.error || 'Email lookup failed'
        const isLimit = data?.isLimit || /limit|quota|credit|reach|exceed|payment|usage/i.test(errorMsg)
        const runUrl = data?.runUrl || 'https://console.apify.com'
        if (isLimit) {
          const limitMsg = `Email Scraper limit reached: ${errorMsg}`
          setIsEmailLimitReached(true)
          setEmailLimitMessage(errorMsg)
          setEmailLimitRunUrl(runUrl)
          setApifyError(limitMsg)
          setRowErrors((prev) => ({ ...prev, [`email_${lead.id}`]: limitMsg }))
          setLimitModal({
            isOpen: true,
            title: 'Email Limit Reached',
            message: errorMsg,
            type: 'email',
            runUrl: runUrl,
            leadToRetry: lead,
          })
        } else {
          setRowErrors((prev) => ({ ...prev, [`email_${lead.id}`]: errorMsg }))
        }
        return
      }

      // Success from Apify
      setIsEmailLimitReached(false)
      const emailFound = typeof data.email === 'string' && data.email.trim().length > 0
      const phoneFound = hasPhoneValue(data?.phone)

      if (emailFound && data.email) {
        // Automatically queue newly enriched lead into weekly email queue
        void queueContactsForWeeklyEmail([{
          id: lead.id,
          contact_id: `lead-${lead.id}`,
          email: data.email,
          full_name: data.full_name || lead.full_name || '',
          company: data.company_name || lead.company_name || '',
          designation: data.designation || lead.designation,
          industry: lead.industry,
        }])
      }

      if (!emailFound) {
        const notFoundMsg = data?.rawLog || data?.reason || 'Actor completed search cleanly on Apify but found no verified email for this profile.'
        const runUrl = data?.runUrl || emailLimitRunUrl
        setLookupLogs((prev) => ({ ...prev, [`email_${lead.id}`]: { message: notFoundMsg, runUrl } }))
        setLimitModal({
          isOpen: true,
          title: 'Email Not Found',
          message: notFoundMsg,
          type: 'email',
          runUrl: runUrl,
          leadToRetry: lead,
        })
        // Genuinely not found: actor completed search cleanly but found no email
        setEmailNotFoundIds((prev) => {
          const next = new Set(prev)
          next.add(lead.id)
          if (lead.linkedinUrl) next.add(lead.linkedinUrl)
          return next
        })
        if (lead.id) {
          void supabase.from('leads').update({ email_attempted: true }).eq('id', lead.id)
        }
      }

      setLeads((prev) =>
        prev.map((l) =>
          l.id === lead.id
            ? {
                ...l,
                // Only overwrite if something was returned — keep existing value otherwise
                email:           emailFound ? data.email        : l.email,
                phone:           phoneFound ? data.phone        : l.phone,
                full_name:       data.full_name    || l.full_name,
                company_name:    data.company_name || l.company_name,
                designation:     data.designation  || l.designation,
                email_attempted: true,
              }
            : l,
        ),
      )
    } catch (e: any) {
      const errorMsg = e?.message || 'Email lookup failed'
      const isLimit = /limit|quota|credit|reach|exceed|payment|usage/i.test(errorMsg)
      if (isLimit) {
        const limitMsg = `Email Scraper limit reached: ${errorMsg}`
        setIsEmailLimitReached(true)
        setEmailLimitMessage(errorMsg)
        setApifyError(limitMsg)
        setRowErrors((prev) => ({ ...prev, [`email_${lead.id}`]: limitMsg }))
        setLimitModal({
          isOpen: true,
          title: 'Email Limit Reached',
          message: errorMsg,
          type: 'email',
          leadToRetry: lead,
        })
      } else {
        setRowErrors((prev) => ({ ...prev, [`email_${lead.id}`]: errorMsg }))
      }
    } finally {
      setEnriching((prev) => { const next = new Set(prev); next.delete(lead.id); return next })
    }
  }

  const hasFilters =
    filters.name !== '' ||
    filters.company !== '' ||
    filters.industry !== '' ||
    filters.designation !== '' ||
    filters.geography !== '' ||
    filters.state !== '' ||
    filters.role !== '' ||
    filters.companySize !== ''

  const tableQuery = tableSearch.trim().toLowerCase()
  // The name, company dropdown and table search narrow displayed rows; the other
  // dropdowns are inputs to the Apify search only.
  // So a search that returns 0 new leads still renders every existing lead, and
  // the table can only be empty when the database is empty or the user typed a
  // search term that matches nothing.
  const isFromCurrentSearch = (lead: Lead) => {
    if (!searchResultLeadIds || searchResultLeadIds.size === 0) return false
    const idKey = (lead.id || '').toLowerCase()
    const urlKey = (lead.linkedinUrl || '').toLowerCase()
    return (idKey && searchResultLeadIds.has(idKey)) || (urlKey && searchResultLeadIds.has(urlKey))
  }

  const nameFilteredLeads = filters.name.trim()
    ? leads.filter((lead) => isFromCurrentSearch(lead) || leadMatchesName(lead, filters.name))
    : leads
  const companyFilteredLeads = filters.company.trim()
    ? nameFilteredLeads.filter((lead) => isFromCurrentSearch(lead) || leadMatchesCompany(lead, filters.company))
    : nameFilteredLeads
  const filteredLeads = tableQuery
    ? companyFilteredLeads.filter((lead) =>
        Object.values(lead).some((v) => String(v ?? '').toLowerCase().includes(tableQuery)),
      )
    : companyFilteredLeads

  // ─── DUAL HORIZONTAL SCROLLBARS (top + bottom, synced) ───
  const leadTableRef = useRef<HTMLDivElement | null>(null)
  const leadTableScrollbarRef = useRef<HTMLDivElement | null>(null)
  const [leadTableDimensions, setLeadTableDimensions] = useState({ clientWidth: 0, scrollWidth: 0 })

  useEffect(() => {
    const table = leadTableRef.current
    if (!table) return

    const measure = () => {
      setLeadTableDimensions({ clientWidth: table.clientWidth, scrollWidth: table.scrollWidth })
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(table)
    if (table.firstElementChild) {
      observer.observe(table.firstElementChild)
    }
    return () => observer.disconnect()
  }, [leads.length, filteredLeads.length, loading, searched])

  const handleLeadTableScroll = (source: 'table' | 'scrollbar') => {
    const sourceElement = source === 'table' ? leadTableRef.current : leadTableScrollbarRef.current
    const targetElement = source === 'table' ? leadTableScrollbarRef.current : leadTableRef.current
    if (sourceElement && targetElement && targetElement.scrollLeft !== sourceElement.scrollLeft) {
      targetElement.scrollLeft = sourceElement.scrollLeft
    }
  }

  const csvCell = (v: unknown): string => {
    const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim()
    return `"${s.replace(/"/g, '""')}"`
  }

  const phoneCell = (v: unknown): string => {
    const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim()
    if (!s) return '""'
    return `"=""${s.replace(/"/g, '""')}"""`
  }

  const handleDownloadCSV = () => {
    if (filteredLeads.length === 0) {
      setNotice('No leads to export')
      return
    }
    const headers = ['Name', 'Company', 'Job Title', 'Designation', 'Email', 'Phone', 'LinkedIn', 'Industry', 'Geography', 'Department']
    const rows = filteredLeads.map((lead) =>
      [
        lead.full_name,
        lead.company_name,
        lead.job_title,
        cleanDesignation(lead.designation, lead.job_title, lead.company_name),
        lead.email,
        lead.phone,
        lead.linkedinUrl,
        lead.industry,
        lead.geography,
        lead.role,
      ]
        .map((v, i) => (i === 5 ? phoneCell(v) : csvCell(v))),
    )
    const csv = '\uFEFF' + [headers.map(csvCell).join(','), ...rows.map((r) => r.join(','))].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `leads_${fileStamp()}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const fileStamp = () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
  }

  const handleDownloadExcel = () => {
    if (filteredLeads.length === 0) {
      setNotice('No leads to export')
      return
    }
    const headers = ['Name', 'Company', 'Job Title', 'Designation', 'Email', 'Phone', 'LinkedIn', 'Industry', 'Geography', 'Department']
    const rows = filteredLeads.map((lead) => [
      lead.full_name ?? '',
      lead.company_name ?? '',
      lead.job_title ?? '',
      cleanDesignation(lead.designation, lead.job_title, lead.company_name),
      lead.email ?? '',
      lead.phone ?? '',
      lead.linkedinUrl ?? '',
      lead.industry ?? '',
      lead.geography ?? '',
      lead.role ?? '',
    ])
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
    ws['!cols'] = [
      { wch: 20 }, // Name
      { wch: 20 }, // Company
      { wch: 24 }, // Job Title
      { wch: 40 }, // Designation
      { wch: 26 }, // Email
      { wch: 16 }, // Phone
      { wch: 34 }, // LinkedIn
      { wch: 18 }, // Industry
      { wch: 16 }, // Geography
      { wch: 18 }, // Role
    ]
    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:J1')
    for (let r = 1; r <= range.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: 5 })] // Phone column
      if (cell) {
        cell.t = 's'
        cell.z = '@'
        cell.v = String(cell.v ?? '')
      }
    }
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Leads')
    XLSX.writeFile(wb, `leads_${fileStamp()}.xlsx`)
  }

  const handleDownloadPDF = () => {
    if (filteredLeads.length === 0) {
      setNotice('No leads to export')
      return
    }
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

    doc.setFontSize(16)
    doc.setFont('helvetica', 'bold')
    doc.text('Lead Search Results', 40, 40)
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(100)
    doc.text(`Generated on ${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}`, 40, 58)

    const f = filters
    const parts: string[] = []
    if (f.industry) parts.push(`Industry=${f.industry}`)
    if (f.designation) parts.push(`Designation=${f.designation}`)
    if (f.geography) parts.push(`Geography=${f.geography}`)
    if (f.role) parts.push(`Department=${f.role}`)
    doc.text(parts.length ? `Filters: ${parts.join(', ')}` : 'Filters: None', 40, 74)
    doc.setFontSize(11)
    doc.setTextColor(0)
    doc.text(`${filteredLeads.length} lead${filteredLeads.length === 1 ? '' : 's'}`, 40, 90)

    const headers = ['Name', 'Company', 'Job Title', 'Designation', 'Email', 'Phone', 'LinkedIn', 'Industry', 'Geography', 'Department']
    const body = filteredLeads.map((lead) => [
      lead.full_name ?? '',
      lead.company_name ?? '',
      lead.job_title ?? '',
      cleanDesignation(lead.designation, lead.job_title, lead.company_name),
      lead.email ?? '',
      lead.phone ?? '',
      lead.linkedinUrl ?? '',
      lead.industry ?? '',
      lead.geography ?? '',
      lead.role ?? '',
    ])

    autoTable(doc, {
      startY: 104,
      head: [headers],
      body,
      margin: { left: 40, right: 40 },
      styles: { fontSize: 7.5, cellPadding: 4, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [220, 220, 220], textColor: [0, 0, 0], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: {
        0: { cellWidth: 70 }, // Name
        1: { cellWidth: 70 }, // Company
        2: { cellWidth: 70 }, // Job Title
        3: { cellWidth: 90 }, // Designation
        4: { cellWidth: 80 }, // Email
        5: { cellWidth: 60 }, // Phone
        6: { cellWidth: 90 }, // LinkedIn
        7: { cellWidth: 55 }, // Industry
        8: { cellWidth: 50 }, // Geography
        9: { cellWidth: 50 }, // Role
      },
    })
    doc.save(`leads_${fileStamp()}.pdf`)
  }

  const isGeoEmpty = !filters.geography || !filters.geography.trim()

  const comboboxFields: {
    key: 'company' | 'industry' | 'designation' | 'geography' | 'state' | 'role'
    label: string
    options: string[]
    customOptions?: string[]
    onAddCustom?: (value: string) => void
    onRemoveCustom?: (value: string) => void
    disabled?: boolean
    placeholder?: string
    loading?: boolean
    error?: string | null
    emptyMessage?: string
    allowCustom?: boolean
  }[] = [
    {
      key: 'company',
      label: 'Company',
      options: mergeUnique([companyOptions]),
      customOptions: customCompanies,
      onAddCustom: addCustomCompany,
      onRemoveCustom: removeCustomCompany,
      placeholder: 'Type or select company...',
      allowCustom: true,
      loading: companyLoading,
      error: companyError,
      emptyMessage: 'Type any company name...',
    },
    {
      key: 'industry',
      label: 'Industry',
      options: mergeUnique([industryOptions]),
      customOptions: customIndustries,
      onAddCustom: addCustomIndustry,
      onRemoveCustom: removeCustomIndustry,
      placeholder: 'All Industry',
    },
    {
      key: 'designation',
      label: 'Designation',
      options: mergeUnique([designationOptions]),
      customOptions: customDesignations,
      onAddCustom: addCustomDesignation,
      onRemoveCustom: removeCustomDesignation,
      placeholder: 'All Designation',
    },
    {
      key: 'geography',
      label: 'Geography',
      options: mergeUnique([geographyOptions]),
      customOptions: customGeographies,
      onAddCustom: addCustomGeography,
      onRemoveCustom: removeCustomGeography,
      placeholder: 'All Geography',
    },
    {
      key: 'state',
      label: 'State',
      options: mergeUnique([stateOptions]),
      customOptions: isGeoEmpty ? [] : customStates,
      onAddCustom: addCustomState,
      onRemoveCustom: removeCustomState,
      disabled: isGeoEmpty,
      placeholder: isGeoEmpty ? 'Select Geography first' : 'All State',
    },
    {
      key: 'role',
      label: 'Department',
      options: mergeUnique([departmentOptions]),
      customOptions: customRoles,
      onAddCustom: addCustomRole,
      onRemoveCustom: removeCustomRole,
      placeholder: 'All Department',
    },
  ]

  const handleFindPhone = async (leadId: string, linkedinUrl: string, _forceRetry = false) => {
    if (fetchingPhoneId) return // prevent concurrent fetches
    if (!leadId || !linkedinUrl) {
      alert('No LinkedIn profile for this lead')
      return
    }

    const currentLead = leads.find((l) => l.id === leadId)

    // Clear any previous "not found" / error state so Fetching... shows immediately
    setPhoneNotFoundIds((prev) => { const s = new Set(prev); s.delete(leadId); if (linkedinUrl) s.delete(linkedinUrl); return s })
    setRowErrors((prev) => { const next = { ...prev }; delete next[`phone_${leadId}`]; return next })
    setFetchingPhoneId(leadId)

    try {
      const { data, error } = await supabase.functions.invoke('find-phone', {
        body: { leadId, linkedinUrl },
      })

      if (error) {
        let errText = error.message || 'Phone lookup failed'
        let isLimit = false
        let errorRunUrl = phoneLimitRunUrl || 'https://console.apify.com/actors/J9mf98b4CIZpW72Ue/runs'
        try {
          if ('context' in error && typeof (error as any).context?.json === 'function') {
            const ctxJson = await (error as any).context.json()
            if (ctxJson?.apifyError || ctxJson?.reason || ctxJson?.error) {
              errText = ctxJson.apifyError || ctxJson.reason || ctxJson.error
            }
            if (ctxJson?.isLimit) isLimit = true
            if (ctxJson?.runUrl) {
              errorRunUrl = ctxJson.runUrl
              setPhoneLimitRunUrl(ctxJson.runUrl)
            }
          }
        } catch {}
        if (!isLimit) {
          isLimit = /free plan limit|limit of \d+|15\/15|upgrade to a paid|usage limit|insufficient credit|quota/i.test(errText)
        }
        if (isLimit) {
          const limitMsg = `Phone Scraper limit reached: ${errText}`
          setLimitModal({
            isOpen: true,
            title: 'Phone Limit Reached',
            message: errText,
            type: 'phone',
            runUrl: errorRunUrl,
            leadToRetry: currentLead,
          })
          setRowErrors((prev) => ({ ...prev, [`phone_${leadId}`]: limitMsg }))
        } else {
          setRowErrors((prev) => ({ ...prev, [`phone_${leadId}`]: errText }))
        }
        return
      }

      if (!data?.success) {
        const errorMsg = data?.apifyError || data?.reason || data?.error || 'Phone lookup failed'
        const isLimit = data?.isLimit || /free plan limit|limit of \d+|15\/15|upgrade to a paid|usage limit|insufficient credit|quota/i.test(errorMsg)
        const runUrl = data?.runUrl || phoneLimitRunUrl || 'https://console.apify.com/actors/J9mf98b4CIZpW72Ue/runs'
        if (data?.runUrl) {
          setPhoneLimitRunUrl(data.runUrl)
        }
        if (isLimit) {
          const limitMsg = `Phone Scraper limit reached: ${errorMsg}`
          setLimitModal({
            isOpen: true,
            title: 'Phone Limit Reached',
            message: errorMsg,
            type: 'phone',
            runUrl: runUrl,
            leadToRetry: currentLead,
          })
          setRowErrors((prev) => ({ ...prev, [`phone_${leadId}`]: limitMsg }))
        } else {
          setRowErrors((prev) => ({ ...prev, [`phone_${leadId}`]: errorMsg }))
        }
        return
      }

      if (data?.runUrl) {
        setPhoneLimitRunUrl(data.runUrl)
      }

      if (!hasPhoneValue(data?.phone)) {
        const notFoundMsg = data?.rawLog || data?.reason || 'Actor completed search cleanly on Apify but found no registered phone number for this profile.'
        const runUrl = data?.runUrl || phoneLimitRunUrl
        setLookupLogs((prev) => ({ ...prev, [`phone_${leadId}`]: { message: notFoundMsg, runUrl } }))
        setLimitModal({
          isOpen: true,
          title: 'Phone Not Found',
          message: notFoundMsg,
          type: 'phone',
          runUrl: runUrl,
          leadToRetry: currentLead,
        })
        // Actor returned no phone
        setPhoneNotFoundIds((prev) => {
          const next = new Set(prev)
          next.add(leadId)
          if (linkedinUrl) next.add(linkedinUrl)
          return next
        })
        if (leadId) {
          void supabase.from('leads').update({ phone_attempted: true }).eq('id', leadId)
        }
        setLeads((prev) =>
          prev.map((l) => (l.id === leadId ? { ...l, phone_attempted: true } : l)),
        )
        return
      }

      // Success — update local state so the number shows immediately
      setLeads((prev) =>
        prev.map((l) => (l.id === leadId ? { ...l, phone: data.phone, phone_attempted: true } : l)),
      )
    } catch (err: any) {
      const errorMsg = err?.message || 'Phone lookup failed'
      const runUrl = phoneLimitRunUrl || 'https://console.apify.com/actors/J9mf98b4CIZpW72Ue/runs'
      setPhoneLimitRunUrl(runUrl)
      setRowErrors((prev) => ({ ...prev, [`phone_${leadId}`]: errorMsg }))
      setLimitModal({
        isOpen: true,
        title: 'Phone Limit Reached',
        message: errorMsg,
        type: 'phone',
        runUrl: runUrl,
        leadToRetry: currentLead,
      })
    } finally {
      setFetchingPhoneId(null)
    }
  }

  const handleDelete = async (leadId: string) => {
    if (!leadId) return
    if (!window.confirm('Delete this lead? This cannot be undone.')) return
    setDeletingId(leadId)
    try {
      const { error } = await supabase
        .from('leads')
        .delete()
        .eq('id', leadId)
      if (error) throw error
      setLeads((prev) => prev.filter((l) => l.id !== leadId))
    } catch (e: any) {
      alert(e?.message || 'Failed to delete lead')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="page active">
      {error && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            color: '#b91c1c',
            padding: '10px 14px',
            borderRadius: 'var(--r)',
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {apifyError && (
        <div
          style={{
            background: '#fff1f2',
            border: '1px solid #fecdd3',
            color: '#9f1239',
            padding: '12px 16px',
            borderRadius: 'var(--r)',
            marginBottom: 16,
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 700 }}>
                {/limit|credit|quota|reach|exceed/i.test(apifyError)
                  ? 'Apify Scraper Limit Reached'
                  : 'Apify Scraper Service Error'}
              </div>
              <div style={{ marginTop: '2px', color: '#881337' }}>{apifyError}</div>
            </div>
          </div>
          <button
            onClick={() => setApifyError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#9f1239',
              cursor: 'pointer',
              fontSize: '16px',
              fontWeight: 'bold',
              padding: '2px 6px',
            }}
            title="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* ─── Header ─── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '14px',
          flexWrap: 'wrap',
          marginBottom: '18px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            type="button"
            onClick={handleBack}
            className="btn btn-ghost"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '36px',
              height: '36px',
              padding: 0,
              borderRadius: '9px',
              border: '1px solid var(--border2)',
              background: 'var(--surface)',
              color: 'var(--text1)',
              cursor: 'pointer',
              boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)',
              transition: 'all 0.15s ease',
              flexShrink: 0,
            }}
            title="Back to previous page"
            aria-label="Back to previous page"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text1)' }}>Lead Search</div>
            <div style={{ fontSize: '12.5px', color: 'var(--text4)', marginTop: '2px' }}>
              Find B2B leads by filters
            </div>
          </div>
        </div>

        {onNavigate && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onNavigate('lead-database')}
            style={{ fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <span>Lead Database</span>
            <span>→</span>
          </button>
        )}
      </div>

      {notice && (
        <div
          style={{
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#1d4ed8',
            padding: '10px 14px',
            borderRadius: 'var(--r)',
            marginBottom: 16,
            fontSize: '12.5px',
          }}
        >
          {notice}
        </div>
      )}

      {/* ─── Filter Dropdowns ─── */}
      <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '14px',
          }}
        >
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="ss-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Name</span>
              {filters.name && (
                <span
                  onClick={() => setFilters({ ...filters, name: '' })}
                  style={{ cursor: 'pointer', fontSize: '11px', color: 'var(--text4)', fontWeight: 'normal' }}
                  title="Clear name"
                >
                  ✕ Clear
                </span>
              )}
            </label>
            <input
              type="text"
              className="ss-trigger"
              style={{
                cursor: 'text',
                boxSizing: 'border-box',
                height: '38px',
              }}
              placeholder="e.g. Rajiv Sharma..."
              value={filters.name}
              onChange={(e) => setFilters({ ...filters, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch()
              }}
            />
          </div>
          {comboboxFields.map((field) => (
            <SearchableSelect
              key={field.key}
              label={field.label}
              value={filters[field.key]}
              options={field.options.map((o) => ({ value: o, label: o }))}
              customOptions={field.customOptions}
              onAddCustom={field.onAddCustom}
              onRemoveCustom={field.onRemoveCustom}
              onChange={(value) => handleSelect(field.key, value)}
              placeholder={field.placeholder || `All ${field.label}`}
              disabled={field.disabled}
              loading={field.loading}
              error={field.error}
              emptyMessage={field.emptyMessage}
              allowCustom={field.allowCustom}
            />
          ))}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <SearchableSelect
              label="Company Size"
              value={filters.companySize}
              options={companySizes.map((n) => ({ value: n.value, label: n.label }))}
              customOptions={customCompanySizes}
              onAddCustom={addCustomCompanySize}
              onRemoveCustom={removeCustomCompanySize}
              onChange={(value) => handleSelect('companySize', value)}
              placeholder="All Company Size"
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Number of Profiles</label>
            <select
              className="seqb-filter"
              value={filters.maxItems}
              onChange={(e) =>
                setFilters({ ...filters, maxItems: Number(e.target.value) })
              }
            >
              {profileCounts.map((n) => (
                <option key={n.id} value={n.value}>
                  {n.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {filterMetaLoading && (
        <div style={{ fontSize: '12px', color: 'var(--text4)', marginBottom: '10px' }}>
          Loading filter options…
        </div>
      )}
      {filterMetaError && (
        <div style={{ fontSize: '12px', color: '#b91c1c', marginBottom: '10px' }}>
          ⚠️ {filterMetaError}
        </div>
      )}

      {/* ─── Action Area ─── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '18px' }}>
        <button
          className="btn btn-primary"
          onClick={() => void handleSearch()}
          disabled={loading}
          style={{ padding: '9px 22px', fontSize: '13.5px' }}
        >
          {loading && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, borderTopColor: '#fff' }} />}
          {loading ? 'Searching…' : 'Search Leads'}
        </button>
        {hasFilters && (
          <button
            className="btn"
            onClick={() => {
              setFilters({ ...DEFAULT_FILTERS })
              setSearchResultLeadIds(null)
            }}
            style={{ fontSize: '12.5px' }}
          >
            Clear filters
          </button>
        )}
        {leads.length > 0 && (
          <button
            className="btn"
            onClick={handleResetSearch}
            style={{ fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            title="Reset results and return to Lead Generation search filters"
          >
            <span>←</span>
            <span>Back to search</span>
          </button>
        )}
        {leads.length > 0 && (
          <button
            className="btn"
            onClick={() => void handleClearSavedLeads()}
            style={{ fontSize: '12.5px' }}
          >
            Clear saved leads
          </button>
        )}
        {leads.length > 0 && (
          <button
            className="btn"
            onClick={() => void handleDownloadCSV()}
            disabled={leads.length === 0}
            style={{ fontSize: '12.5px' }}
          >
            Download CSV
          </button>
        )}
        {leads.length > 0 && (
          <button
            className="btn"
            onClick={() => void handleDownloadExcel()}
            disabled={leads.length === 0}
            style={{ fontSize: '12.5px' }}
          >
            Export to Excel
          </button>
        )}
        {leads.length > 0 && (
          <button
            className="btn"
            onClick={() => void handleDownloadPDF()}
            disabled={leads.length === 0}
            style={{ fontSize: '12.5px' }}
          >
            Download PDF
          </button>
        )}
      </div>

      {/* ─── Tier Fallback Execution History & Raw JSON Inspector ─── */}
      {tierAttempts && tierAttempts.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            border: '1px solid var(--border)',
            borderRadius: 'var(--r)',
            padding: '12px 16px',
            background: 'var(--card-bg, #fafafa)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text1)' }}>
              Tier Fallback Execution History ({tierAttempts.length} Tier{tierAttempts.length === 1 ? '' : 's'} Attempted)
            </div>
            <button
              className="btn"
              type="button"
              onClick={() => setShowTierDebug(!showTierDebug)}
              style={{ fontSize: '11.5px', padding: '4px 10px' }}
            >
              {showTierDebug ? 'Hide Raw JSON' : 'View Raw Apify Request & Response JSON'}
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: '12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tierAttempts.map((att: any, idx: number) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span
                  style={{
                    display: 'inline-block',
                    padding: '2px 6px',
                    borderRadius: 4,
                    fontSize: '11px',
                    fontWeight: 600,
                    background: att.matchedItemsCount > 0 ? '#dcfce7' : '#f3f4f6',
                    color: att.matchedItemsCount > 0 ? '#15803d' : '#6b7280',
                  }}
                >
                  {att.name}
                </span>
                <span style={{ color: 'var(--text2)', fontWeight: 500 }}>{att.description}:</span>
                <span style={{ color: 'var(--text3)' }}>
                  {att.rawItemsCount} raw items from Apify,{' '}
                  <strong style={{ color: att.matchedItemsCount > 0 ? '#15803d' : 'inherit' }}>
                    {att.matchedItemsCount} name-matched
                  </strong>
                  {att.statusMessage ? ` — ${att.statusMessage}` : ''}
                </span>
              </div>
            ))}
          </div>
          {showTierDebug && (
            <div style={{ marginTop: 12 }}>
              <pre
                style={{
                  background: '#0f172a',
                  color: '#f8fafc',
                  padding: '12px',
                  borderRadius: 6,
                  fontSize: '11.5px',
                  overflowX: 'auto',
                  maxHeight: '350px',
                }}
              >
                {JSON.stringify(tierAttempts, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* ─── Results ─── */}
      {leads.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            marginBottom: '12px',
          }}
        >
          <div style={{ position: 'relative', width: '100%', maxWidth: 420 }}>
            <input
              type="text"
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              placeholder="Search leads..."
              aria-label="Search leads"
              style={{
                width: '100%',
                padding: '9px 34px 9px 12px',
                border: '1px solid var(--border2)',
                borderRadius: 8,
                fontSize: '13px',
                color: 'var(--text1)',
                background: '#fff',
                outline: 'none',
              }}
            />
            {tableSearch && (
              <button
                aria-label="Clear search"
                onClick={() => setTableSearch('')}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: '15px',
                  lineHeight: 1,
                  color: 'var(--text4)',
                  padding: '2px 4px',
                }}
              >
                ×
              </button>
            )}
          </div>
          {searched && !loading && (
            <div style={{ fontSize: '12.5px', color: 'var(--text3)', marginLeft: 'auto' }}>
              {tableSearch.trim() || filters.company
                ? `${filteredLeads.length} of ${leads.length} leads shown`
                : `${leads.length} leads found`}
            </div>
          )}
        </div>
      )}
      {apifyError && (
        <div
          style={{
            background: '#fff1f2',
            border: '1px solid #fecdd3',
            color: '#9f1239',
            padding: '10px 16px',
            borderRadius: 'var(--r)',
            marginBottom: 12,
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '16px' }}>⚠️</span>
            <div>
              <strong>
                {/limit|credit|quota|reach|exceed|payment|usage/i.test(apifyError)
                  ? 'Apify Scraper Limit Reached'
                  : 'Apify Service Error'}
              </strong>
              <div style={{ marginTop: '2px', color: '#881337', fontSize: '12.5px' }}>{apifyError}</div>
            </div>
          </div>
          <button
            onClick={() => setApifyError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#9f1239',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '16px',
              padding: '2px 6px',
            }}
            title="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}
      {leadTableDimensions.scrollWidth > leadTableDimensions.clientWidth && (
        <div
          className="ct-table-scrollbar"
          ref={leadTableScrollbarRef}
          onScroll={() => handleLeadTableScroll('scrollbar')}
          aria-hidden="true"
          style={{
            borderTopLeftRadius: 'var(--r)',
            borderTopRightRadius: 'var(--r)',
            border: '1px solid var(--border)',
            borderBottom: 'none',
            marginBottom: -1,
          }}
        >
          <div
            style={{
              width: leadTableDimensions.scrollWidth,
              minWidth: leadTableDimensions.scrollWidth,
              height: 1,
            }}
          />
        </div>
      )}
      <div
        className="table-wrap"
        ref={leadTableRef}
        onScroll={() => handleLeadTableScroll('table')}
        style={leadTableDimensions.scrollWidth > leadTableDimensions.clientWidth ? {
          borderTopLeftRadius: 0,
          borderTopRightRadius: 0,
        } : undefined}
      >
        {filteredLeads.length > 0 ? (
          <table>
            <thead>
              <tr>
                {['Name', 'Company', 'Job Title', 'Email', 'Phone', 'LinkedIn', 'Industry', 'Geography', 'Department', 'Delete'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredLeads.map((lead, i) => (
                <tr key={lead.id ?? lead.linkedinUrl ?? i}>
                  <td>{lead.full_name || '—'}</td>
                  <td>{lead.company_name?.trim() || companyFromDesignation(lead.designation) || '—'}</td>
                  <td>{lead.job_title || '—'}</td>
                  <td>
                    {lead.email ? (
                      <span style={{ fontSize: '12.5px' }}>{lead.email}</span>
                    ) : enriching.has(lead.id) ? (
                      <span style={{ fontSize: '12.5px', opacity: 0.6 }}>Fetching...</span>
                    ) : rowErrors[`email_${lead.id}`] ? (
                      <span
                        style={{
                          fontSize: '11.5px',
                          color: '#dc2626',
                          background: '#fef2f2',
                          border: '1px solid #fecaca',
                          padding: '2px 7px',
                          borderRadius: '4px',
                          fontWeight: 600,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        <span
                          style={{ cursor: 'pointer' }}
                          title={rowErrors[`email_${lead.id}`]}
                          onClick={() => {
                            const isLimit = /limit|credit|quota|reach|exceed|payment|usage/i.test(rowErrors[`email_${lead.id}`])
                            setLimitModal({
                              isOpen: true,
                              title: isLimit ? 'Email Limit Reached' : 'Email Lookup Error',
                              message: rowErrors[`email_${lead.id}`],
                              type: 'email',
                              leadToRetry: lead,
                            })
                          }}
                        >
                          {/limit|credit|quota|reach|exceed|payment|usage/i.test(rowErrors[`email_${lead.id}`])
                            ? '⚠️ Limit Reached'
                            : '⚠️ Error'}
                        </span>
                        <button
                          style={{
                            fontSize: '11px',
                            color: '#b91c1c',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            textDecoration: 'underline',
                            fontWeight: 600,
                            marginLeft: '2px',
                          }}
                          onClick={() => {
                            setRowErrors((prev) => {
                              const next = { ...prev }
                              delete next[`email_${lead.id}`]
                              return next
                            })
                            void handleEnrichLead(lead, true)
                          }}
                        >
                          Retry
                        </button>
                      </span>
                    ) : (!lead.email && (emailNotFoundIds.has(lead.id) || (lead.linkedinUrl && emailNotFoundIds.has(lead.linkedinUrl)) || lead.email_attempted === true)) ? (
                      <span style={{ fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <span
                          style={{
                            color: '#64748b',
                            background: '#f8fafc',
                            border: '1px solid #cbd5e1',
                            padding: '2px 7px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '11.5px',
                            fontWeight: 500,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                          title="Click to view Apify log output and details"
                          onClick={() => {
                            const stored = lookupLogs[`email_${lead.id}`]
                            setLimitModal({
                              isOpen: true,
                              title: 'Email Not Found in Apify',
                              message: stored?.message || 'Actor completed search on Apify but found no verified email for this profile in Apify database.',
                              type: 'email',
                              runUrl: stored?.runUrl || (emailLimitRunUrl || 'https://console.apify.com/actors/bfH8Ermocz8oYKQVO/runs'),
                              leadToRetry: lead,
                            })
                          }}
                        >
                          <span>Not Found</span>
                          <span style={{ fontSize: '11px', color: 'var(--accent)' }}>📋</span>
                        </span>
                        <button
                          style={{ fontSize: '11px', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                          onClick={() => {
                            setEmailNotFoundIds((prev) => {
                              const s = new Set(prev)
                              s.delete(lead.id)
                              if (lead.linkedinUrl) s.delete(lead.linkedinUrl)
                              return s
                            })
                            setRowErrors((prev) => {
                              const next = { ...prev }
                              delete next[`email_${lead.id}`]
                              return next
                            })
                            setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, email_attempted: false } : l)))
                            if (lead.id) {
                              void supabase.from('leads').update({ email_attempted: false }).eq('id', lead.id)
                            }
                            void handleEnrichLead(lead, true)
                          }}
                        >Retry</button>
                      </span>
                    ) : (
                      <button
                        className="btn"
                        disabled={enriching.has(lead.id) || !lead.id}
                        onClick={() => void handleEnrichLead(lead)}
                        style={{ fontSize: '12.5px', padding: '4px 12px' }}
                      >
                        Find Email
                      </button>
                    )}
                  </td>
                  <td>
                    {hasPhoneValue(lead.phone) ? (
                      <span style={{ fontSize: '12.5px' }}>{lead.phone}</span>
                    ) : fetchingPhoneId === lead.id ? (
                      <span style={{ fontSize: '12.5px', opacity: 0.6 }}>Fetching...</span>
                    ) : rowErrors[`phone_${lead.id}`] ? (
                      <span
                        style={{
                          fontSize: '11.5px',
                          color: '#dc2626',
                          background: '#fef2f2',
                          border: '1px solid #fecaca',
                          padding: '2px 7px',
                          borderRadius: '4px',
                          fontWeight: 600,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        <span
                          style={{ cursor: 'pointer' }}
                          title={rowErrors[`phone_${lead.id}`]}
                          onClick={() => {
                            const isLimit = /limit|credit|quota|reach|exceed|payment|usage/i.test(rowErrors[`phone_${lead.id}`])
                            setLimitModal({
                              isOpen: true,
                              title: isLimit ? 'Phone Limit Reached' : 'Phone Lookup Error',
                              message: rowErrors[`phone_${lead.id}`],
                              type: 'phone',
                              runUrl: phoneLimitRunUrl || 'https://console.apify.com/actors/J9mf98b4CIZpW72Ue/runs',
                            })
                          }}
                        >
                          {/limit|credit|quota|reach|exceed|payment|usage/i.test(rowErrors[`phone_${lead.id}`])
                            ? '⚠️ Limit Reached'
                            : '⚠️ Error'}
                        </span>
                        <button
                          style={{
                            fontSize: '11px',
                            color: '#b91c1c',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            textDecoration: 'underline',
                            fontWeight: 600,
                            marginLeft: '2px',
                          }}
                          onClick={() => {
                            setRowErrors((prev) => {
                              const next = { ...prev }
                              delete next[`phone_${lead.id}`]
                              return next
                            })
                            if (lead.linkedinUrl) {
                              void handleFindPhone(lead.id, lead.linkedinUrl, true)
                            }
                          }}
                        >
                          Retry
                        </button>
                      </span>
                    ) : (!hasPhoneValue(lead.phone) && (phoneNotFoundIds.has(lead.id) || (lead.linkedinUrl && phoneNotFoundIds.has(lead.linkedinUrl)) || lead.phone_attempted === true)) ? (
                      <span style={{ fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <span
                          style={{
                            color: '#64748b',
                            background: '#f8fafc',
                            border: '1px solid #cbd5e1',
                            padding: '2px 7px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '11.5px',
                            fontWeight: 500,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                          title="Click to view Apify log output and details"
                          onClick={() => {
                            const stored = lookupLogs[`phone_${lead.id}`]
                            setLimitModal({
                              isOpen: true,
                              title: 'Phone Not Found in Apify',
                              message: stored?.message || 'Actor completed search on Apify but found no registered phone number for this profile in Apify database.',
                              type: 'phone',
                              runUrl: stored?.runUrl || (phoneLimitRunUrl || 'https://console.apify.com/actors/J9mf98b4CIZpW72Ue/runs'),
                              leadToRetry: lead,
                            })
                          }}
                        >
                          <span>Not Found</span>
                          <span style={{ fontSize: '11px', color: 'var(--accent)' }}>📋</span>
                        </span>
                        <button
                          style={{ fontSize: '11px', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                          onClick={() => {
                            setPhoneNotFoundIds((prev) => {
                              const s = new Set(prev)
                              s.delete(lead.id)
                              if (lead.linkedinUrl) s.delete(lead.linkedinUrl)
                              return s
                            })
                            setRowErrors((prev) => {
                              const next = { ...prev }
                              delete next[`phone_${lead.id}`]
                              return next
                            })
                            setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, phone_attempted: false } : l)))
                            if (lead.id) {
                              void supabase.from('leads').update({ phone_attempted: false }).eq('id', lead.id)
                            }
                            if (lead.linkedinUrl) {
                              void handleFindPhone(lead.id, lead.linkedinUrl, true)
                            }
                          }}
                        >Retry</button>
                      </span>
                    ) : (
                      <button
                        className="btn"
                        disabled={fetchingPhoneId !== null || !lead.id}
                        onClick={() =>
                          lead.linkedinUrl
                            ? void handleFindPhone(lead.id, lead.linkedinUrl)
                            : alert('No LinkedIn profile for this lead')
                        }
                        style={{ fontSize: '12.5px', padding: '4px 12px' }}
                      >
                        Find Phone
                      </button>
                    )}
                  </td>
                  <td>
                    {lead.linkedinUrl ? (
                      <a
                        href={lead.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: '12.5px', fontWeight: 600 }}
                      >
                        View Profile
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{lead.industry || '—'}</td>
                  <td>{lead.geography || '—'}</td>
                  <td>{lead.role || '—'}</td>

                  <td>
                    <button
                      className="btn btn-secondary"
                      disabled={deletingId === lead.id || !lead.id}
                      onClick={() => void handleDelete(lead.id)}
                      title="Delete lead"
                      style={{
                        fontSize: '12.5px',
                        padding: '4px 12px',
                        color: '#dc2626',
                        borderColor: '#fca5a5',
                      }}
                    >
                      {deletingId === lead.id ? 'Deleting...' : '🗑️'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : leads.length > 0 ? (
          <div className="empty-state" style={{ padding: '44px 28px' }}>
            <div className="empty-icon">🔍</div>
            <div className="empty-title">No matches found</div>
            <div className="empty-sub">
              {tableSearch.trim()
                ? `No leads match "${tableSearch.trim()}".`
                : filters.name.trim()
                ? `No leads in database match the name "${filters.name.trim()}". Click "Search Leads" to search LinkedIn via Apify.`
                : filters.company.trim()
                ? `No leads in database match the company "${filters.company.trim()}".`
                : 'No leads match the selected filters.'}
            </div>
          </div>
        ) : (
          <div className="empty-state" style={{ padding: '44px 28px' }}>
            <div className="empty-icon">🔍</div>
            <div className="empty-title">No leads found</div>
            <div className="empty-sub">
              {searched && notice ? notice : 'Use the filters above to start your search.'}
            </div>
          </div>
        )}
      </div>

      {/* ─── LIMIT REACHED / NOT FOUND / RUN LOG MODAL POPUP ─── */}
      {limitModal.isOpen && (() => {
        const isNotFound = (limitModal.title || '').toLowerCase().includes('not found')
        return (
          <div
            className="modal-overlay"
            style={{ zIndex: 1000 }}
            onClick={() => setLimitModal((prev) => ({ ...prev, isOpen: false }))}
          >
            <div
              className="modal"
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: '520px',
                border: isNotFound ? '1px solid #cbd5e1' : '1px solid #fecdd3',
                boxShadow: isNotFound
                  ? '0 25px 50px -12px rgba(15, 23, 42, 0.2)'
                  : '0 25px 50px -12px rgba(159, 18, 57, 0.25)',
                overflow: 'hidden',
              }}
            >
              <div
                className="modal-header"
                style={{
                  background: isNotFound ? '#f8fafc' : '#fff1f2',
                  borderBottom: isNotFound ? '1px solid #e2e8f0' : '1px solid #fecdd3',
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '8px',
                      background: isNotFound ? '#e2e8f0' : '#ffe4e6',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '20px',
                    }}
                  >
                    {isNotFound ? '📋' : '⚠️'}
                  </div>
                  <div>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: '16px',
                        fontWeight: 700,
                        color: isNotFound ? '#0f172a' : '#9f1239',
                      }}
                    >
                      {limitModal.title || 'Apify Result'}
                    </h3>
                    <p
                      style={{
                        margin: 0,
                        fontSize: '12px',
                        color: isNotFound ? '#64748b' : '#be123c',
                        marginTop: '2px',
                      }}
                    >
                      {isNotFound
                        ? 'Apify Search Completed — Not Recorded in Apify Database'
                        : 'Apify Scraper Limit / Usage Exceeded'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setLimitModal((prev) => ({ ...prev, isOpen: false }))}
                  className="modal-close"
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '18px',
                    cursor: 'pointer',
                    color: isNotFound ? '#64748b' : '#9f1239',
                    fontWeight: 'bold',
                    padding: '4px 8px',
                    borderRadius: '4px',
                  }}
                >
                  ✕
                </button>
              </div>

              <div className="modal-body" style={{ padding: '20px' }}>
                <div
                  style={{
                    background: '#fff',
                    border: isNotFound ? '1px solid #e2e8f0' : '1px solid #fecdd3',
                    borderRadius: '8px',
                    padding: '14px',
                    fontSize: '13px',
                    lineHeight: 1.5,
                    color: isNotFound ? '#1e293b' : '#881337',
                    marginBottom: '16px',
                    wordBreak: 'break-word',
                  }}
                >
                  <div
                    style={{
                      fontWeight: 700,
                      marginBottom: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>Apify Run Output / Issue:</span>
                    {limitModal.leadToRetry && (
                      <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 500 }}>
                        {limitModal.leadToRetry.full_name || limitModal.leadToRetry.company_name}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      fontSize: '12.5px',
                      color: isNotFound ? '#334155' : '#9f1239',
                      whiteSpace: 'pre-wrap',
                      background: isNotFound ? '#f8fafc' : '#fff1f2',
                      padding: '10px 12px',
                      borderRadius: '6px',
                      border: isNotFound ? '1px solid #e2e8f0' : '1px solid #fecdd3',
                      lineHeight: '1.45',
                      maxHeight: '220px',
                      overflowY: 'auto',
                    }}
                  >
                    {limitModal.message ||
                      (isNotFound
                        ? 'Actor ran on Apify but found no matching record in database for this contact profile.'
                        : 'Free plan: 15/15 requests used, 0 remaining\nFree plan limit of 15 requests reached. Upgrade to a paid Apify plan to continue.')}
                  </div>
                </div>

                <p
                  style={{
                    fontSize: '13px',
                    color: 'var(--text2, #475569)',
                    margin: 0,
                    lineHeight: 1.5,
                  }}
                >
                  {isNotFound
                    ? limitModal.type === 'email'
                      ? 'Apify searched its database for this LinkedIn profile, but found no verified email address. You can click "Open Apify Log ↗" below to review the full actor execution log on Apify Console.'
                      : limitModal.type === 'phone'
                      ? 'Apify searched its database for this LinkedIn profile, but found no registered mobile number. You can click "Open Apify Log ↗" below to review the full actor execution log on Apify Console.'
                      : 'Apify searched for this contact, but found no record in its database. You can click "Open Apify Log ↗" below to inspect the run log.'
                    : limitModal.type === 'email'
                    ? 'Your Apify email scraper run limit has been reached. Please upgrade your Apify plan or add credits to continue discovering email addresses.'
                    : limitModal.type === 'phone'
                    ? 'Your Apify phone scraper run limit has been reached. Please upgrade your Apify plan or add credits to continue discovering phone numbers.'
                    : 'Your Apify scraper run limit has been reached. Please upgrade your Apify plan or add credits to continue.'}
                </p>
              </div>

              <div
                className="modal-footer"
                style={{
                  padding: '14px 20px',
                  borderTop: '1px solid var(--border)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: 'var(--surface2, #fafafa)',
                }}
              >
                <a
                  href={
                    limitModal.runUrl ||
                    (limitModal.type === 'phone'
                      ? (phoneLimitRunUrl || 'https://console.apify.com/actors/J9mf98b4CIZpW72Ue/runs')
                      : (emailLimitRunUrl || 'https://console.apify.com/actors/bfH8Ermocz8oYKQVO/runs'))
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn"
                  style={{
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12.5px',
                    padding: '6px 12px',
                    background: '#f1f5f9',
                    borderColor: '#cbd5e1',
                    color: '#0f172a',
                    fontWeight: 600,
                  }}
                >
                  Open Apify Log ↗
                </a>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {limitModal.leadToRetry && (
                    <button
                      className="btn"
                      style={{ fontSize: '12.5px', padding: '6px 14px' }}
                      onClick={() => {
                        const lead = limitModal.leadToRetry
                        setLimitModal((prev) => ({ ...prev, isOpen: false }))
                        if (lead) {
                          if (limitModal.type === 'phone' && lead.linkedinUrl) {
                            void handleFindPhone(lead.id, lead.linkedinUrl, true)
                          } else {
                            void handleEnrichLead(lead, true)
                          }
                        }
                      }}
                    >
                      {isNotFound ? 'Retry Search' : 'Try Anyway'}
                    </button>
                  )}
                  <button
                    className="btn btn-primary"
                    onClick={() => setLimitModal((prev) => ({ ...prev, isOpen: false }))}
                    style={{ fontSize: '12.5px', padding: '6px 16px' }}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}