import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

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

const INDUSTRY_OPTIONS = ['Marketing', 'Finance', 'Healthcare', 'Manufacturing', 'Retail', 'Education']
const DESIGNATION_OPTIONS = [
  { label: 'General', value: 'General' },
  { label: 'VP', value: 'VP' },
  { label: 'Head', value: 'Head' },
  { label: 'Director', value: 'Director' },
  { label: 'Manager', value: 'Manager' },
  { label: 'C-Level', value: 'CEO' },
]
const GEOGRAPHY_OPTIONS = ['India', 'USA', 'UK', 'UAE', 'Singapore', 'Australia']
const ROLE_OPTIONS = ['Marketing', 'Sales', 'R&D', 'Engineering', 'HR', 'Finance']
const COMPANY_SIZE_OPTIONS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']

const DROPDOWNS: { key: keyof Filters; label: string; options: { label: string; value: string }[] | string[] }[] = [
  { key: 'industry', label: 'Industry', options: INDUSTRY_OPTIONS },
  { key: 'designation', label: 'Designation', options: DESIGNATION_OPTIONS },
  { key: 'geography', label: 'Geography', options: GEOGRAPHY_OPTIONS },
  { key: 'role', label: 'Role', options: ROLE_OPTIONS },
  { key: 'companySize', label: 'Company Size', options: COMPANY_SIZE_OPTIONS },
]

const DEFAULT_FILTERS: Filters = { industry: '', designation: '', geography: '', role: '', companySize: '', maxItems: 5 }

export default function LeadSearch() {
  const [filters, setFilters] = useState<Filters>(() => {
    const saved = localStorage.getItem('leadSearchFilters')
    return saved ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) } : DEFAULT_FILTERS
  })
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [demoMode, setDemoMode] = useState(true)
  const [enriching, setEnriching] = useState<Set<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    localStorage.setItem('leadSearchFilters', JSON.stringify(filters))
  }, [filters])

  useEffect(() => {
    ;(async () => {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
      if (!error) {
        setLeads(
          (data ?? []).map((row) => ({
            id: row.id,
            email: row.email,
            phone: row.phone,
            linkedinUrl: row.linkedin_url,
            full_name: row.full_name,
            company_name: row.company_name,
            designation: row.designation,
            role: row.role,
          })),
        )
      }
    })()
  }, [])

  const handleSelect = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const handleSearch = async () => {
    setLoading(true)
    setError(null)
    setSearched(true)
    try {
      const { data, error } = await supabase.functions.invoke('scrape-leads', {
        body: { filters },
      })
      if (error) throw error
      setLeads(data.data ?? [])
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
          {DROPDOWNS.map((field) => (
            <div className="form-group" key={field.key} style={{ marginBottom: 0 }}>
              <label>{field.label}</label>
              <select
                className="seqb-filter"
                value={filters[field.key]}
                onChange={(e) => handleSelect(field.key, e.target.value)}
              >
                <option value="">All {field.label}</option>
                {field.options.map((opt) => {
                  const label = typeof opt === 'string' ? opt : opt.label
                  const value = typeof opt === 'string' ? opt : opt.value
                  return (
                    <option key={label} value={value}>
                      {label}
                    </option>
                  )
                })}
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
              {[2, 3, 5, 10, 20, 50].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

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
                {['Name', 'Company', 'Designation', 'Email', 'LinkedIn', 'Actions'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map((lead, i) => (
                <tr key={lead.id ?? lead.linkedinUrl ?? i}>
                  <td>{lead.full_name || '—'}</td>
                  <td>{lead.company_name || '—'}</td>
                  <td>{lead.designation || '—'}</td>
                  <td>{lead.email || '—'}</td>
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
                      {enriching.has(lead.id) ? '…' : lead.email ? 'Re-fetch' : 'Find Email'}
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
            <div className="empty-sub">Use the filters above to start your search.</div>
          </div>
        )}
      </div>
    </div>
  )
}