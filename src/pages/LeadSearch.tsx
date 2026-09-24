import { useState, useEffect } from 'react'
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
  type FilterOption,
  type ProfileCountOption,
} from '../services/filterService'
import {
  addCustomFilterOption,
  fetchCustomFilterOptions,
  removeCustomFilterOption,
} from '../services/customFilterOptionsService'
import SearchableSelect from '../components/SearchableSelect'

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
  phone_attempted?: boolean
  email_attempted?: boolean
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
    phone_attempted: row.phone_attempted === true,
    email_attempted: row.email_attempted === true,
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
  const [, setRowErrors] = useState<Record<string, string>>({})
  const [tableSearch, setTableSearch] = useState('')

  const [companySizes, setCompanySizes] = useState<FilterOption[]>([])
  const [profileCounts, setProfileCounts] = useState<ProfileCountOption[]>([])
  const [filterMetaLoading, setFilterMetaLoading] = useState(true)
  const [filterMetaError, setFilterMetaError] = useState<string | null>(null)

  const [industryOptions, setIndustryOptions] = useState<string[]>([])
  const [designationOptions, setDesignationOptions] = useState<string[]>([])
  const [geographyOptions, setGeographyOptions] = useState<string[]>([])
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([])

  const [customIndustries, setCustomIndustries] = useState<string[]>(() => loadCustomValues('custom_industries'))
  const [customDesignations, setCustomDesignations] = useState<string[]>(() => loadCustomValues('custom_designations'))
  const [customGeographies, setCustomGeographies] = useState<string[]>(() => loadCustomValues('custom_geographies'))
  const [customRoles, setCustomRoles] = useState<string[]>([])

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

  // Load every filter dropdown from its master table on mount so the options
  // always reflect the database (single source of truth), never hardcoded
  // lists. Geography labels can appear under multiple values ("India" vs
  // "india") so they are de-duplicated; the 'all' sentinel row is skipped.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [ind, des, geo, dept, cs, np] = await Promise.all([
        fetchIndustries(),
        fetchDesignations(),
        fetchGeographies(),
        fetchDepartments(),
        fetchCompanySizes(),
        fetchNumberOfProfiles(),
      ])
      if (cancelled) return
      setIndustryOptions(ind.data.map((o) => o.label))
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

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await fetchCustomFilterOptions(['designation'])
      if (cancelled) return
      if (error) {
        // Not a user-facing failure — the custom-options table may not be
        // migrated yet, in which case we just fall back to localStorage.
        console.error(`[LeadSearch] Could not load saved custom options: ${error}`)
        return
      }
      const saved = data.designation ?? []
      if (saved.length === 0) return
      setCustomDesignations((prev) => {
        const merged = [...prev]
        for (const s of saved) {
          if (!merged.some((x) => x.toLowerCase() === s.toLowerCase())) merged.push(s)
        }
        return merged
      })
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

  const handleSelect = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const addCustomIndustry = (value: string) => {
    const v = value.trim()
    if (!v) return
    setCustomIndustries((prev) =>
      prev.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      industryOptions.some((x) => x.toLowerCase() === v.toLowerCase())
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
    const exists =
      customDesignations.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      designationOptions.some((x) => x.toLowerCase() === v.toLowerCase())
    if (exists) return
    setCustomDesignations((prev) =>
      prev.some((x) => x.toLowerCase() === v.toLowerCase()) ? prev : [...prev, v],
    )
    void addCustomFilterOption('designation', v).then((res) => {
      setNotice(res.error ? `Could not save "${v}": ${res.error}` : `Saved "${v}" as a custom option`)
    })
  }
  const removeCustomDesignation = (value: string) => {
    setCustomDesignations((prev) => prev.filter((x) => x !== value))
    void removeCustomFilterOption('designation', value).then((res) => {
      if (res.error) setNotice(`Could not remove "${value}": ${res.error}`)
    })
  }

  const addCustomGeography = (value: string) => {
    const v = value.trim()
    if (!v) return
    setCustomGeographies((prev) =>
      prev.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      geographyOptions.some((x) => x.toLowerCase() === v.toLowerCase())
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
    if (
      departmentOptions.some((x) => x.toLowerCase() === v.toLowerCase()) ||
      customRoles.some((x) => x.toLowerCase() === v.toLowerCase())
    ) {
      return
    }
    void supabase
      .from('departments')
      .insert({ label: v, value: v })
      .then(({ error }) => {
        if (error) {
          setNotice(`Could not save department "${v}": ${error.message}`)
          return
        }
        setCustomRoles((prev) =>
          prev.some((x) => x.toLowerCase() === v.toLowerCase()) ? prev : [...prev, v],
        )
        setNotice(`Saved "${v}" as a department`)
      })
  }
  const removeCustomRole = (value: string) => {
    setCustomRoles((prev) => prev.filter((x) => x !== value))
    void supabase
      .from('departments')
      .delete()
      .eq('label', value)
      .then(({ error }) => {
        if (error) setNotice(`Could not remove "${value}": ${error.message}`)
      })
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
                email_attempted: true,
                phone_attempted: hasPhoneValue(data?.phone) ? l.phone_attempted : true,
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
      options: mergeUnique([industryOptions]),
      customOptions: customIndustries,
      onAddCustom: addCustomIndustry,
      onRemoveCustom: removeCustomIndustry,
    },
    {
      key: 'designation',
      label: 'Designation',
      options: mergeUnique([designationOptions]),
      customOptions: customDesignations,
      onAddCustom: addCustomDesignation,
      onRemoveCustom: removeCustomDesignation,
    },
    {
      key: 'geography',
      label: 'Geography',
      options: mergeUnique([geographyOptions]),
      customOptions: customGeographies,
      onAddCustom: addCustomGeography,
      onRemoveCustom: removeCustomGeography,
    },
    {
      key: 'role',
      label: 'Department',
      options: mergeUnique([departmentOptions]),
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
        // Flag the row locally (the backend also persists it) so the cell shows
        // "Not Found" — matching the refresh-persisted state.
        setLeads((prev) =>
          prev.map((l) => (l.id === leadId ? { ...l, phone_attempted: true } : l)),
        )
        alert(data?.error || error?.message || 'Failed to fetch phone')
        return
      }

      if (!hasPhoneValue(data.phone)) {
        setLeads((prev) =>
          prev.map((l) => (l.id === leadId ? { ...l, phone_attempted: true } : l)),
        )
        return
      }

      // Update local state so the row immediately shows the phone number
      setLeads((prev) =>
        prev.map((l) => (l.id === leadId ? { ...l, phone: data.phone, phone_attempted: true } : l)),
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
            <SearchableSelect
              key={field.key}
              label={field.label}
              value={filters[field.key]}
              options={field.options.map((o) => ({ value: o, label: o }))}
              customOptions={field.customOptions}
              onAddCustom={field.onAddCustom}
              onRemoveCustom={field.onRemoveCustom}
              onChange={(value) => handleSelect(field.key, value)}
              placeholder={`All ${field.label}`}
            />
          ))}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <SearchableSelect
              label="Company Size"
              value={filters.companySize}
              options={companySizes.map((n) => ({ value: n.value, label: n.label }))}
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
                    ) : lead.email_attempted === true ? (
                      <span style={{ fontSize: '12.5px', color: '#9ca3af', fontStyle: 'italic' }}>Not Found</span>
                    ) : (
                      <button
                        className="btn"
                        disabled={enriching.has(lead.id) || !lead.id}
                        onClick={() => void handleEnrichLead(lead)}
                        style={{ fontSize: '12.5px', padding: '4px 12px' }}
                      >
                        {enriching.has(lead.id) ? '…' : 'Find Email'}
                      </button>
                    )}
                  </td>
                  <td>
                    {hasPhoneValue(lead.phone) ? (
                      <span style={{ fontSize: '12.5px' }}>{lead.phone}</span>
                    ) : fetchingPhoneId === lead.id ? (
                      <span style={{ fontSize: '12.5px', opacity: 0.6 }}>Fetching...</span>
                    ) : lead.phone_attempted === true ? (
                      <span style={{ fontSize: '12.5px', color: '#9ca3af', fontStyle: 'italic' }}>Not Found</span>
                    ) : (
                      <button
                        className="btn"
                        disabled={!lead.id}
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