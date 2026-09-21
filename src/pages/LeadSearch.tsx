import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { supabase } from '../supabase'
import {
  fetchCompanySizes,
  fetchNumberOfProfiles,
  type FilterOption,
  type ProfileCountOption,
} from '../services/filterService'

interface Lead {
  id: string
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
}

interface Filters {
  industry: string
  designation: string
  geography: string
  role: string
  companySize: string
  maxItems: number
}

const DEFAULT_FILTERS: Filters = { industry: '', designation: '', geography: '', role: '', companySize: '', maxItems: 5 }

const INDUSTRY_OPTIONS = [
  'Information Technology',
  'Software Development',
  'Artificial Intelligence',
  'Cybersecurity',
  'Cloud Computing',
  'Telecommunications',
  'Finance',
  'Banking',
  'Insurance',
  'Real Estate',
  'Accounting',
  'Management Consulting',
  'Human Resources',
  'Healthcare',
  'Pharmaceuticals',
  'Biotechnology',
  'Medical Devices',
  'Manufacturing',
  'Retail',
  'E-commerce',
  'Education',
  'Media',
  'Entertainment',
  'Hospitality',
  'Logistics',
  'Automotive',
  'Energy',
  'Utilities',
  'Construction',
  'Agriculture',
  'Legal Services',
  'Marketing',
  'Advertising',
]

const DESIGNATION_OPTIONS = [
  'CEO',
  'CTO',
  'CFO',
  'COO',
  'Founder',
  'Co-Founder',
  'President',
  'VP',
  'Director',
  'Head',
  'General Manager',
  'Senior Manager',
  'Manager',
  'Lead',
  'Engineer',
  'Developer',
  'Analyst',
  'Consultant',
  'Specialist',
  'Executive',
]

const GEOGRAPHY_OPTIONS = [
  'India',
  'USA',
  'UK',
  'Canada',
  'Australia',
  'Singapore',
  'UAE',
  'Germany',
  'France',
  'Japan',
  'China',
  'Brazil',
  'South Africa',
  'Netherlands',
  'Switzerland',
  'Dubai',
]

const ROLE_OPTIONS = [
  'Engineering',
  'Sales',
  'Marketing',
  'Product',
  'Design',
  'Finance',
  'Operations',
  'Human Resources',
  'Legal',
  'IT',
  'Customer Success',
  'Business Development',
  'Research',
  'Data',
  'Consulting',
]

type ComboboxKey = 'industry' | 'designation' | 'geography' | 'role'

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
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    full_name: row.full_name,
    company_name: row.company_name,
    job_title: row.job_title || '',
    designation: row.designation,
    role: row.role || '',
    industry: row.industry,
    geography: row.geography,
  }
}

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

function Combobox({
  label,
  value,
  options,
  customOptions,
  placeholder,
  onSelect,
  onAddCustom,
  onRemoveCustom,
}: {
  label: string
  value: string
  options: string[]
  customOptions: string[]
  placeholder: string
  onSelect: (value: string) => void
  onAddCustom: (value: string) => void
  onRemoveCustom: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addText, setAddText] = useState('')
  const [hovered, setHovered] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const display = editing ? draft : value

  useEffect(() => {
    if (!open) return
    const handleOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setEditing(false)
        setOpen(false)
        setAdding(false)
        setAddText('')
        setHovered(null)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [open])

  const choose = (v: string) => {
    onSelect(v)
    setDraft(v)
    setEditing(false)
    setOpen(false)
    setAdding(false)
    setAddText('')
    setHovered(null)
  }

  const confirmAdd = () => {
    const t = addText.trim()
    if (!t) return
    onAddCustom(t)
    choose(t)
  }

  const confirmAddWith = (t: string) => {
    if (!t) return
    onAddCustom(t)
    choose(t)
  }

  const query = editing ? draft.trim().toLowerCase() : ''
  const seen = new Set<string>()
  const rows: { label: string; value: string; custom: boolean }[] = [
    { label: placeholder, value: '', custom: false },
    ...options.map((o) => ({ label: o, value: o, custom: false })),
    ...customOptions.map((o) => ({ label: o, value: o, custom: true })),
  ].filter((r) => {
    const key = r.label.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const filtered = rows.filter((r) => r.label.toLowerCase().includes(query))

  return (
    <div className="form-group" style={{ marginBottom: 0, position: 'relative' }} ref={rootRef}>
      <label>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          value={display}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          style={{ paddingRight: 32 }}
          onChange={(e) => {
            setDraft(e.target.value)
            setEditing(true)
            setOpen(true)
          }}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
              setOpen(false)
              setAdding(false)
              setAddText('')
              setHovered(null)
              e.currentTarget.blur()
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(display.trim())
            }
          }}
        />
        <span
          onClick={() => setOpen((v) => !v)}
          style={{
            position: 'absolute',
            right: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 11,
            lineHeight: 1,
            color: 'var(--text4)',
            cursor: 'pointer',
            userSelect: 'none',
            zIndex: 2,
          }}
        >
          ▾
        </span>
      </div>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 40,
            marginTop: 4,
            maxHeight: 240,
            overflowY: 'auto',
            background: '#fff',
            border: '1px solid var(--border2)',
            borderRadius: 8,
            boxShadow: '0 6px 16px rgba(15, 23, 42, 0.12)',
          }}
        >
          {filtered.length > 0 ? (
            filtered.map((r) => {
              const active = hovered === r.label || r.value === value
              return (
                <div
                  key={r.label}
                  role="option"
                  aria-selected={r.value === value}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(r.value)
                  }}
                  onMouseEnter={() => setHovered(r.label)}
                  onMouseLeave={() => setHovered((h) => (h === r.label ? null : h))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 12px',
                    fontSize: '12.5px',
                    cursor: 'pointer',
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? '#fff' : 'var(--text1)',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.label}
                  </span>
                  {r.custom && (
                    <span
                      title={`Remove ${r.label}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemoveCustom(r.label)
                        setHovered(null)
                      }}
                      style={{
                        marginLeft: 8,
                        fontSize: 15,
                        lineHeight: 1,
                        padding: '0 3px',
                        cursor: 'pointer',
                        color: active ? '#fff' : 'var(--text4)',
                        opacity: hovered === r.label ? 1 : 0,
                      }}
                    >
                      ×
                    </span>
                  )}
                </div>
              )
            })
          ) : editing && query.trim() ? (
            <div
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => confirmAddWith(draft.trim())}
              style={{
                padding: '8px 12px',
                fontSize: '12.5px',
                color: 'var(--accent)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              + Add Custom {label} '{draft.trim()}'
            </div>
          ) : (
            <div style={{ padding: '8px 12px', fontSize: '12.5px', color: 'var(--text4)' }}>
              No options match
            </div>
          )}
          <div style={{ borderTop: '1px solid var(--border2)' }}>
            {adding ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: 8 }}>
                <input
                  type="text"
                  value={addText}
                  placeholder={`Custom ${label}…`}
                  autoFocus
                  onChange={(e) => setAddText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      confirmAdd()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setAdding(false)
                      setAddText('')
                    }
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '7px 10px',
                    border: '1px solid var(--border2)',
                    borderRadius: 6,
                    fontSize: '12.5px',
                    color: 'var(--text1)',
                    background: 'var(--surface)',
                    outline: 'none',
                  }}
                />
                <button
                  className="btn btn-primary"
                  onClick={confirmAdd}
                  style={{ padding: '7px 12px', fontSize: '12.5px', flexShrink: 0 }}
                >
                  Add
                </button>
              </div>
            ) : (
              <div
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setAddText(editing ? draft : '')
                  setAdding(true)
                }}
                style={{
                  padding: '8px 12px',
                  fontSize: '12.5px',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                + Add Custom {label}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function LeadSearch() {
  const [filters, setFilters] = useState<Filters>(() => {
    const saved = localStorage.getItem('leadSearchFilters')
    return saved ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) } : DEFAULT_FILTERS
  })
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [demoMode, setDemoMode] = useState(true)
  const [enriching, setEnriching] = useState<Set<string>>(new Set())
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [fetchingPhoneId, setFetchingPhoneId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [tableSearch, setTableSearch] = useState('')

  const [companySizes, setCompanySizes] = useState<FilterOption[]>([])
  const [profileCounts, setProfileCounts] = useState<ProfileCountOption[]>([])
  const [filterMetaLoading, setFilterMetaLoading] = useState(true)
  const [filterMetaError, setFilterMetaError] = useState<string | null>(null)

  const [customIndustries, setCustomIndustries] = useState<string[]>(() => loadCustomValues('custom_industries'))
  const [customDesignations, setCustomDesignations] = useState<string[]>(() => loadCustomValues('custom_designations'))
  const [customGeographies, setCustomGeographies] = useState<string[]>(() => loadCustomValues('custom_geographies'))
  const [customRoles, setCustomRoles] = useState<string[]>(() => loadCustomValues('custom_roles'))
  const [dbOptions, setDbOptions] = useState<Record<ComboboxKey, string[]>>({
    industry: [],
    designation: [],
    geography: [],
    role: [],
  })

  useEffect(() => {
    localStorage.setItem('leadSearchFilters', JSON.stringify(filters))
  }, [filters])

  useEffect(() => {
    localStorage.setItem('custom_industries', JSON.stringify(customIndustries))
  }, [customIndustries])

  useEffect(() => {
    localStorage.setItem('custom_designations', JSON.stringify(customDesignations))
  }, [customDesignations])

  useEffect(() => {
    localStorage.setItem('custom_geographies', JSON.stringify(customGeographies))
  }, [customGeographies])

  useEffect(() => {
    localStorage.setItem('custom_roles', JSON.stringify(customRoles))
  }, [customRoles])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [cs, np] = await Promise.all([fetchCompanySizes(), fetchNumberOfProfiles()])
      if (cancelled) return
      setCompanySizes(cs.data)
      setProfileCounts(np.data)
      setFilterMetaError([cs, np].map((r) => r.error).filter(Boolean).join('; ') || null)
      setFilterMetaLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
      if (!error) {
        setLeads((data ?? []).map(leadFromRow))
      }
    })()
  }, [])

  // Load filter values from the master tables on mount so the comboboxes can
  // offer them as selectable options (merged with presets). Falls back to
  // values already present in the leads table when a master table is missing.
  useEffect(() => {
    let cancelled = false

    const masterTables: Record<ComboboxKey, string> = {
      industry: 'industries',
      designation: 'designations',
      geography: 'geographies',
      role: 'roles',
    }

    const collectKey = (rows: Array<Record<string, unknown>>, key: string): string[] => {
      const seen = new Set<string>()
      const out: string[] = []
      for (const row of rows) {
        const raw = typeof row[key] === 'string' ? (row[key] as string).trim() : ''
        const k = raw.toLowerCase()
        if (raw && !seen.has(k)) {
          seen.add(k)
          out.push(raw)
        }
      }
      return out
    }

    // Probe the table with progressively simpler query shapes so it works no
    // matter which columns actually exist (is_active / sort_order may be absent):
    //   1. active + sort_order → 2. active only → 3. sort_order only → 4. labels only.
    // Preferred = active + sorted rows; if that succeeds but returns zero rows
    // (e.g. everything inactive) we keep trying so every existing label surfaces.
    const fetchMasterLabels = async (table: string): Promise<string[]> => {
      const variants = [
        { active: true, ordered: true },
        { active: true, ordered: false },
        { active: false, ordered: true },
        { active: false, ordered: false },
      ]
      let lastValid: string[] | null = null
      for (const variant of variants) {
        let q = supabase.from(table).select('label')
        if (variant.active) q = q.eq('is_active', true)
        if (variant.ordered) q = q.order('sort_order', { ascending: true })
        const { data, error } = await q
        if (error) continue
        const labels = collectKey((data as Array<Record<string, unknown>>) ?? [], 'label')
        if (labels.length > 0) return labels
        if (lastValid === null) lastValid = labels
      }
      return lastValid ?? []
    }

    const fetchLeadsFallback = async (key: ComboboxKey): Promise<string[]> => {
      const { data, error } = await supabase.from('leads').select(key)
      if (error || !data) return []
      return collectKey(data as Array<Record<string, unknown>>, key)
    }

    ;(async () => {
      const keys = Object.keys(masterTables) as ComboboxKey[]
      const results = await Promise.all(
        keys.map(async (key) => {
          const master = await fetchMasterLabels(masterTables[key])
          const labels = master.length ? master : await fetchLeadsFallback(key)
          return [key, labels] as const
        }),
      )
      if (cancelled) return
      const next: Record<ComboboxKey, string[]> = {
        industry: [],
        designation: [],
        geography: [],
        role: [],
      }
      for (const [key, labels] of results) next[key] = labels
      console.info('[LeadSearch] loaded filter options:', next)
      setDbOptions(next)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const handleSelect = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const addCustomIndustry = (value: string) => {
    const v = value.trim()
    if (!v) return
    setCustomIndustries((prev) =>
      prev.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      INDUSTRY_OPTIONS.some((x) => x.toLowerCase() === v.toLowerCase())
        ? prev
        : [...prev, v],
    )
  }
  const removeCustomIndustry = (value: string) => {
    setCustomIndustries((prev) => prev.filter((x) => x !== value))
  }

  const addCustomDesignation = (value: string) => {
    const v = value.trim()
    if (!v) return
    setCustomDesignations((prev) =>
      prev.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      DESIGNATION_OPTIONS.some((x) => x.toLowerCase() === v.toLowerCase())
        ? prev
        : [...prev, v],
    )
  }
  const removeCustomDesignation = (value: string) => {
    setCustomDesignations((prev) => prev.filter((x) => x !== value))
  }

  const addCustomGeography = (value: string) => {
    const v = value.trim()
    if (!v) return
    setCustomGeographies((prev) =>
      prev.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      GEOGRAPHY_OPTIONS.some((x) => x.toLowerCase() === v.toLowerCase())
        ? prev
        : [...prev, v],
    )
  }
  const removeCustomGeography = (value: string) => {
    setCustomGeographies((prev) => prev.filter((x) => x !== value))
  }

  const addCustomRole = (value: string) => {
    const v = value.trim()
    if (!v) return
    setCustomRoles((prev) =>
      prev.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      ROLE_OPTIONS.some((x) => x.toLowerCase() === v.toLowerCase())
        ? prev
        : [...prev, v],
    )
  }
  const removeCustomRole = (value: string) => {
    setCustomRoles((prev) => prev.filter((x) => x !== value))
  }

  const handleSearch = async () => {
    setLoading(true)
    setError(null)
    setNotice(null)
    setSearched(true)
    try {
      const { data, error } = await supabase.functions.invoke('scrape-leads', {
        body: { filters },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'Search failed')

      // Always reflect what's actually in the DB — re-fetch after the Edge
      // Function persists the Apify results.
      const { data: dbLeads, error: fetchError } = await supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false })
      if (fetchError) throw fetchError
      const freshLeads = (dbLeads ?? []).map(leadFromRow)
      setLeads(freshLeads)

      const saved = Number(data.savedCount) || 0
      const found = Number(data.found) || 0
      if (found === 0) {
        setNotice('No leads found for these filters')
      } else if (saved > 0) {
        setNotice(`${saved} new lead${saved === 1 ? '' : 's'} saved`)
      } else {
        setNotice('Search complete')
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

  const handleEnrichLead = async (lead: Lead) => {
    if (!lead.id) return
    setEnriching((prev) => new Set(prev).add(lead.id))
    setRowErrors((prev) => {
      const next = { ...prev }
      delete next[lead.id]
      return next
    })
    try {
      const { data, error } = await supabase.functions.invoke('enrich-lead', {
        body: { leadId: lead.id, linkedinUrl: lead.linkedinUrl },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'Enrichment failed')
      setLeads((prev) =>
        prev.map((l) =>
          l.id === lead.id
            ? {
                ...l,
                email: data.email,
                phone: data.phone,
                full_name: data.full_name || l.full_name,
                company_name: data.company_name || l.company_name,
                designation: data.designation || l.designation,
              }
            : l,
        ),
      )
    } catch (e: any) {
      setRowErrors((prev) => ({ ...prev, [lead.id]: e?.message || 'Enrichment failed' }))
    } finally {
      setEnriching((prev) => {
        const next = new Set(prev)
        next.delete(lead.id)
        return next
      })
    }
  }

  const hasFilters = Object.values(filters).some((v) => v !== '')

  const tableQuery = tableSearch.trim().toLowerCase()
  const filteredLeads = tableQuery
    ? leads.filter((lead) =>
        Object.values(lead).some((v) => String(v ?? '').toLowerCase().includes(tableQuery)),
      )
    : leads

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

  const comboboxFields: {
    key: 'industry' | 'designation' | 'geography' | 'role'
    label: string
    options: string[]
    customOptions: string[]
    onAddCustom: (value: string) => void
    onRemoveCustom: (value: string) => void
  }[] = [
    {
      key: 'industry',
      label: 'Industry',
      options: mergeUnique([INDUSTRY_OPTIONS, dbOptions.industry]),
      customOptions: customIndustries,
      onAddCustom: addCustomIndustry,
      onRemoveCustom: removeCustomIndustry,
    },
    {
      key: 'designation',
      label: 'Designation',
      options: mergeUnique([DESIGNATION_OPTIONS, dbOptions.designation]),
      customOptions: customDesignations,
      onAddCustom: addCustomDesignation,
      onRemoveCustom: removeCustomDesignation,
    },
    {
      key: 'geography',
      label: 'Geography',
      options: mergeUnique([GEOGRAPHY_OPTIONS, dbOptions.geography]),
      customOptions: customGeographies,
      onAddCustom: addCustomGeography,
      onRemoveCustom: removeCustomGeography,
    },
    {
      key: 'role',
      label: 'Department',
      options: mergeUnique([ROLE_OPTIONS, dbOptions.role]),
      customOptions: customRoles,
      onAddCustom: addCustomRole,
      onRemoveCustom: removeCustomRole,
    },
  ]

  const handleFindPhone = async (leadId: string, linkedinUrl: string) => {
    if (fetchingPhoneId) return // prevent concurrent fetches
    if (!leadId || !linkedinUrl) {
      alert('No LinkedIn profile for this lead')
      return
    }
    setFetchingPhoneId(leadId)

    try {
      const { data, error } = await supabase.functions.invoke('find-phone', {
        body: { leadId, linkedinUrl },
      })

      if (error || !data?.success) {
        alert(data?.error || error?.message || 'Failed to fetch phone')
        return
      }

      // Update local state so the row immediately shows the phone number
      setLeads((prev) =>
        prev.map((l) => (l.id === leadId ? { ...l, phone: data.phone } : l)),
      )
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to fetch phone')
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

      {/* ─── Header ─── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '14px',
          flexWrap: 'wrap',
          marginBottom: '18px',
        }}
      >
        <div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text1)' }}>Lead Search</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text4)', marginTop: '2px' }}>
            Find B2B leads by filters
          </div>
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
          onClick={() => setDemoMode((v) => !v)}
          role="switch"
          aria-checked={demoMode}
        >
          <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text3)' }}>Demo Mode</span>
          <span
            style={{
              position: 'relative',
              width: '36px',
              height: '20px',
              borderRadius: '999px',
              background: demoMode ? 'var(--accent)' : 'var(--border2)',
              transition: 'background 0.15s ease',
              display: 'inline-block',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: '2px',
                left: demoMode ? '18px' : '2px',
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                background: '#fff',
                boxShadow: '0 1px 2px rgba(15,23,42,0.3)',
                transition: 'left 0.15s ease',
              }}
            />
          </span>
        </div>
      </div>

      {/* ─── Filter Dropdowns ─── */}
      <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '14px',
          }}
        >
          {comboboxFields.map((field) => (
            <Combobox
              key={field.key}
              label={field.label}
              value={filters[field.key]}
              options={field.options}
              customOptions={field.customOptions}
              placeholder={`All ${field.label}`}
              onSelect={(value) => handleSelect(field.key, value)}
              onAddCustom={field.onAddCustom}
              onRemoveCustom={field.onRemoveCustom}
            />
          ))}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Company Size</label>
            <select
              className="seqb-filter"
              value={filters.companySize}
              onChange={(e) => handleSelect('companySize', e.target.value)}
            >
              <option value="">All Company Size</option>
              {companySizes.map((n) => (
                <option key={n.id} value={n.value}>
                  {n.label}
                </option>
              ))}
            </select>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
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
            onClick={() => setFilters({ ...DEFAULT_FILTERS })}
            style={{ fontSize: '12.5px' }}
          >
            Clear filters
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
              {tableSearch.trim()
                ? `${filteredLeads.length} of ${leads.length} leads shown`
                : `${leads.length} leads found`}
            </div>
          )}
        </div>
      )}
      <div className="table-wrap">
        {filteredLeads.length > 0 ? (
          <table>
            <thead>
              <tr>
                {['Name', 'Company', 'Job Title', 'Email', 'Phone', 'LinkedIn', 'Industry', 'Geography', 'Department', 'Action', 'Delete'].map((h) => (
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
                  <td>{lead.email || '—'}</td>
                  <td>
                    {hasPhoneValue(lead.phone) ? (
                      <span style={{ fontSize: '12.5px' }}>{lead.phone}</span>
                    ) : fetchingPhoneId === lead.id ? (
                      <span style={{ fontSize: '12.5px', opacity: 0.6 }}>Fetching...</span>
                    ) : (
                      <button
                        className="btn"
                        disabled={fetchingPhoneId === lead.id || !lead.id}
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
                    {rowErrors[lead.id] && (
                      <div style={{ color: '#dc2626', fontSize: '11.5px', marginBottom: 4 }}>
                        ⚠️ {rowErrors[lead.id]}
                      </div>
                    )}
                    <button
                      className="btn"
                      disabled={enriching.has(lead.id) || !lead.id}
                      onClick={() => void handleEnrichLead(lead)}
                      style={{ fontSize: '12.5px', padding: '4px 12px' }}
                    >
                      {enriching.has(lead.id) ? '…' : 'Find Email'}
                    </button>
                  </td>
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
            <div className="empty-title">No matches</div>
            <div className="empty-sub">No leads match "{tableSearch}".</div>
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
    </div>
  )
}