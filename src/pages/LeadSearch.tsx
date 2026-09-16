import { useState } from 'react'

interface Lead {
  id?: string
  full_name?: string
  first_name?: string
  last_name?: string
  headline?: string
  title?: string
  email?: string
  email_status?: string
  phone?: string
  linkedin_url?: string
  company_name?: string
  company_industry?: string
  company_size?: number
  company_website?: string
  company_location?: string
}

interface Filters {
  industry: string[]
  designation: string[]
  geography: string[]
  roles: string[]
  companySize: string[]
}

const INDUSTRY = ['Software', 'IT Services', 'Marketing', 'Finance', 'Healthcare', 'Manufacturing', 'Retail', 'Education']
const DESIGNATION = ['General', 'VP', 'Head', 'Director', 'Manager', 'C-Level']
const GEOGRAPHY = ['India', 'USA', 'UK', 'UAE', 'Singapore', 'Australia']
const ROLES = ['Marketing', 'Sales', 'R&D', 'Engineering', 'HR', 'Finance']
const COMPANY_SIZE = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']

const FILTER_PANELS: { key: keyof Filters; label: string; options: string[]; span2?: boolean }[] = [
  { key: 'industry', label: 'INDUSTRY', options: INDUSTRY },
  { key: 'designation', label: 'DESIGNATION / PROFILE', options: DESIGNATION },
  { key: 'geography', label: 'GEOGRAPHY', options: GEOGRAPHY },
  { key: 'roles', label: 'ROLES', options: ROLES },
  { key: 'companySize', label: 'COMPANY SIZE', options: COMPANY_SIZE, span2: true },
]

interface LeadSearchProps {
  onSaveLead?: (lead: Lead) => void
}

export default function LeadSearch({ onSaveLead }: LeadSearchProps) {
  const [filters, setFilters] = useState<Filters>({
    industry: [],
    designation: [],
    geography: [],
    roles: [],
    companySize: [],
  })
  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  const toggleFilter = (key: keyof Filters, value: string) => {
    setFilters((prev) => {
      const arr = prev[key]
      const next = arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
      return { ...prev, [key]: next }
    })
  }

  const search = async () => {
    setLoading(true)
    setError(null)
    setSearched(true)
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/lead-search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...filters, page: 1, limit: 25 }),
        },
      )
      const json = await res.json()
      if (json.success) {
        setLeads(json.leads ?? [])
        setTotal(json.total ?? 0)
      } else {
        setError(json.error || 'Search failed')
      }
    } catch (e: any) {
      setError(e?.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Lead Search</h1>
        <p className="text-sm text-gray-500 mt-1">Find B2B leads by filters</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg mb-4">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        {FILTER_PANELS.map((panel) => (
          <div
            key={panel.key}
            className={`bg-white border rounded-lg p-4 ${panel.span2 ? 'md:col-span-2' : ''}`}
          >
            <div className="text-sm font-semibold mb-2 text-gray-700">{panel.label}</div>
            {panel.options.map((opt) => (
              <label key={opt} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters[panel.key].includes(opt)}
                  onChange={() => toggleFilter(panel.key, opt)}
                  className="rounded border-gray-300"
                />
                {opt}
              </label>
            ))}
          </div>
        ))}
      </div>

      <button
        onClick={() => void search()}
        disabled={loading}
        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold disabled:opacity-50 mb-6"
      >
        {loading ? 'Searching…' : 'Search Leads'}
      </button>

      {searched && !loading && leads.length === 0 && !error && (
        <p className="text-sm text-gray-500 mb-4">No leads found for the selected filters.</p>
      )}

      {leads.length > 0 && (
        <>
          <p className="text-sm text-gray-500 mb-2">
            Showing {leads.length} of {total} leads
          </p>
          <div className="bg-white border rounded-lg overflow-x-auto">
            <table className="min-w-full border">
              <thead className="bg-gray-100">
                <tr>
                  {['Name', 'Title / Headline', 'Company', 'Email', 'Phone', 'LinkedIn', 'Action'].map(
                    (h) => (
                      <th key={h} className="text-left text-xs font-semibold text-gray-600 px-4 py-3 border-b">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {leads.map((lead, i) => (
                  <tr key={lead.id ?? i} className="border-b last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap">
                      {lead.full_name || [lead.first_name, lead.last_name].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{lead.headline || lead.title || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      <div>{lead.company_name || '—'}</div>
                      {(lead.company_size || lead.company_location) && (
                        <div className="text-xs text-gray-400">
                          {[lead.company_size, lead.company_location].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{lead.email || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{lead.phone || '—'}</td>
                    <td className="px-4 py-3 text-sm">
                      {lead.linkedin_url ? (
                        <a
                          href={lead.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          Profile
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {onSaveLead && (
                        <button
                          onClick={() => onSaveLead(lead)}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Save
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
