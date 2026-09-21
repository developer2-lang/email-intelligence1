import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import {
  fetchIndustries,
  fetchDesignations,
  fetchGeographies,
  fetchRoles,
  fetchCompanySizes,
  fetchNumberOfProfiles,
  type FilterOption,
  type ProfileCountOption,
  type RoleOption,
} from '../services/filterService'

interface Lead {
  id: string
  email?: string
  phone?: string
  linkedinUrl?: string
  full_name?: string
  company_name?: string
  designation?: string
  role?: string
}

interface Filters {
  industry: string
  designation: string
  geography: string
  role: string
  companySize: string
  maxItems: number
}

type DropdownOption = { id: string; label: string; value: string }

const DEFAULT_FILTERS: Filters = { industry: '', designation: '', geography: '', role: '', companySize: '', maxItems: 5 }

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

function leadFromRow(row: any): Lead {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    full_name: row.full_name,
    company_name: row.company_name,
    designation: row.designation,
    role: row.role,
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
  const [fetchingPhoneId, setFetchingPhoneId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const [industries, setIndustries] = useState<FilterOption[]>([])
  const [designations, setDesignations] = useState<FilterOption[]>([])
  const [geographies, setGeographies] = useState<FilterOption[]>([])
  const [roles, setRoles] = useState<RoleOption[]>([])
  const [companySizes, setCompanySizes] = useState<FilterOption[]>([])
  const [profileCounts, setProfileCounts] = useState<ProfileCountOption[]>([])
  const [filterMetaLoading, setFilterMetaLoading] = useState(true)
  const [filterMetaError, setFilterMetaError] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem('leadSearchFilters', JSON.stringify(filters))
  }, [filters])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [ind, des, geo, rol, cs, np] = await Promise.all([
        fetchIndustries(),
        fetchDesignations(),
        fetchGeographies(),
        fetchRoles(),
        fetchCompanySizes(),
        fetchNumberOfProfiles(),
      ])
      if (cancelled) return
      setIndustries(ind.data)
      setDesignations(des.data)
      setGeographies(geo.data)
      setRoles(rol.data)
      setCompanySizes(cs.data)
      setProfileCounts(np.data)
      setFilterMetaError(
        [ind, des, geo, rol, cs, np].map((r) => r.error).filter(Boolean).join('; ') || null,
      )
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

  const handleSelect = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
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

  const filterSets: { key: keyof Filters; label: string; options: DropdownOption[] }[] = [
    { key: 'industry', label: 'Industry', options: industries },
    { key: 'designation', label: 'Designation', options: designations },
    { key: 'geography', label: 'Geography', options: geographies },
    { key: 'role', label: 'Role', options: roles },
    { key: 'companySize', label: 'Company Size', options: companySizes },
  ]

  const handleFindPhone = async (leadId: string, linkedinUrl: string) => {
    if (fetchingPhoneId) return // prevent concurrent fetches
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
          {filterSets.map((field) => (
            <div className="form-group" key={field.key} style={{ marginBottom: 0 }}>
              <label>{field.label}</label>
              <select
                className="seqb-filter"
                value={filters[field.key]}
                onChange={(e) => handleSelect(field.key, e.target.value)}
              >
                <option value="">All {field.label}</option>
                {field.options.map((opt) => (
                  <option key={opt.id} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
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
      </div>

      {/* ─── Results ─── */}
      {searched && !loading && leads.length > 0 && (
        <div style={{ fontSize: '12.5px', color: 'var(--text3)', marginBottom: '8px' }}>
          {leads.length} leads found
        </div>
      )}
      <div className="table-wrap">
        {leads.length > 0 ? (
          <table>
            <thead>
              <tr>
                {['Name', 'Company', 'Designation', 'Email', 'Phone', 'LinkedIn', 'Actions'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map((lead, i) => (
                <tr key={lead.id ?? lead.linkedinUrl ?? i}>
                  <td>{lead.full_name || '—'}</td>
                  <td>{lead.company_name?.trim() || companyFromDesignation(lead.designation) || '—'}</td>
                  <td>{lead.designation || '—'}</td>
                  <td>{lead.email || '—'}</td>
                  <td>
                    {hasPhoneValue(lead.phone) ? (
                      <span style={{ fontSize: '12.5px' }}>{lead.phone}</span>
                    ) : fetchingPhoneId === lead.id ? (
                      <button
                        className="btn btn-secondary"
                        disabled
                        style={{ fontSize: '12.5px', padding: '4px 12px', opacity: 0.6 }}
                      >
                        Fetching...
                      </button>
                    ) : (
                      <button
                        className="btn btn-secondary"
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
                    <button
                      className="btn btn-secondary"
                      disabled={deletingId === lead.id || !lead.id}
                      onClick={() => void handleDelete(lead.id)}
                      style={{
                        fontSize: '12.5px',
                        padding: '4px 12px',
                        color: '#dc2626',
                        borderColor: '#fca5a5',
                        marginLeft: 6,
                      }}
                    >
                      {deletingId === lead.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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