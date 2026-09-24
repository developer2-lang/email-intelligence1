import { useState, useMemo, useCallback, useEffect } from 'react';
import { AV_COLORS } from '../constants/constants';
import { supabase } from '../supabase';
import SearchableSelect from '../components/SearchableSelect';
import {
  fetchCustomFilterOptions,
  removeCustomFilterOption,
} from '../services/customFilterOptionsService';


// ─── ICONS (match the Contacts page icon system) ─────────────────────────────
const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const SearchIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const EyeIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EditIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const TrashIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// ─── TYPES ───────────────────────────────────────────────────────────────────
interface LeadRow {
  id: string;
  user_id: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  full_name: string | null;
  headline: string | null;
  company_name: string | null;
  designation: string | null;
  role: string | null;
  job_title: string | null;
  industry: string | null;
  geography: string | null;
  location: string | null;
  source_query: string | null;
  phone_attempted: boolean | null;
  email_attempted: boolean | null;
  created_at: string | null;
}

interface LeadDatabaseProps {
  onToast: (msg: string, type?: string) => void;
}

type SortKey = 'full_name' | 'company_name' | 'industry' | 'created_at';

// ─── HELPERS ───────────────────────────────────────────────────────────────
function initialsOf(name: string): string {
  return (name || '')
    .split(' ')
    .map((x) => x[0])
    .join('')
    .substring(0, 2)
    .toUpperCase() || '??';
}

function fmtDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function emailValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Sentinel value for "(None)" options in the per-column dropdown filters. The
// empty string means "All <column>" (filter cleared), so null/empty rows get
// their own distinct option value.
const NONE = '__none__';

function filterOptions(rows: LeadRow[], pick: (l: LeadRow) => string | null): string[] {
  return Array.from(new Set(rows.map((l) => (pick(l) || '').trim()))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function matchColumn(column: string | null, filter: string): boolean {
  const val = (column || '').trim();
  return filter === NONE ? val === '' : val === filter;
}

// Build {value,label} options for a searchable select from distinct column
// values, preserving the "(None)" sentinel for empty/null rows.
function toSelectOptions(opts: string[]): { value: string; label: string }[] {
  return [
    ...opts.filter((o) => o !== '').map((o) => ({ value: o, label: o })),
    ...(opts.includes('') ? [{ value: NONE, label: '(None)' }] : []),
  ];
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
export default function LeadDatabase({ onToast }: LeadDatabaseProps) {
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [searchVal, setSearchVal] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [geographyFilter, setGeographyFilter] = useState('');

  // Per-column filters (shared state keeps the toolbar Industry/Geography
  // selects and the per-column dropdowns in sync).
  const [nameFilter, setNameFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [phoneFilter, setPhoneFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [designationFilter, setDesignationFilter] = useState('');
  const [customDesignations, setCustomDesignations] = useState<string[]>([]);

  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [viewLead, setViewLead] = useState<LeadRow | null>(null);
  const [editLead, setEditLead] = useState<LeadRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LeadRow | null>(null);

  const [submitting, setSubmitting] = useState(false);

  // Form state for the Edit modal
  const [fName, setFName] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fPhone, setFPhone] = useState('');
  const [fCompany, setFCompany] = useState('');
  const [fDesig, setFDesig] = useState('');
  const [fIndustry, setFIndustry] = useState('');
  const [fGeography, setFGeography] = useState('');
  const [fLinkedin, setFLinkedin] = useState('');

  // ─── DATA FETCHING ───
  // RLS on public.leads already restricts rows to the signed-in user's org
  // (auth.uid() = user_id), so this read only ever returns their own leads.
  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setLeads((data ?? []) as LeadRow[]);
      setFetchError(null);
    } catch (e: any) {
      setFetchError(e?.message || 'Failed to load leads');
      setLeads([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchLeads();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchLeads]);

  // Load the user's saved custom designations (persisted in Supabase) so they
  // survive a page refresh and show up in the Designation dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await fetchCustomFilterOptions(['designation']);
      if (cancelled) return;
      if (error) {
        onToast(`Could not load saved custom designations: ${error}`, 'error');
        return;
      }
      const saved = data.designation ?? [];
      if (saved.length === 0) return;
      setCustomDesignations((prev) => {
        const merged = [...prev];
        for (const s of saved) {
          if (!merged.some((x) => x.toLowerCase() === s.toLowerCase())) merged.push(s);
        }
        return merged;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [onToast]);

  // ─── FILTER OPTIONS (derived from loaded rows) ───
  const industryOptions = useMemo(
    () => filterOptions(leads, (l) => l.industry),
    [leads],
  );

  const geographyOptions = useMemo(
    () => filterOptions(leads, (l) => l.geography || l.location),
    [leads],
  );

  const companyOptions = useMemo(
    () => filterOptions(leads, (l) => l.company_name),
    [leads],
  );

  // Derive unique designations from the loaded leads (already fetched in the
  // table) rather than from the public.designations lookup table.
  const designationOptions = useMemo(() => {
    const unique = Array.from(
      new Set(
        leads
          .map((l) => l.designation)
          .filter((d): d is string => !!d && d.trim() !== ''),
      ),
    ).sort();

    return [
      { value: '', label: 'All Designations' },
      ...unique.map((d) => ({ value: d, label: d })),
    ];
  }, [leads]);

  const companySelectOptions = useMemo(
    () => toSelectOptions(companyOptions),
    [companyOptions],
  );

  const industrySelectOptions = useMemo(
    () => toSelectOptions(industryOptions),
    [industryOptions],
  );

  const geographySelectOptions = useMemo(
    () => toSelectOptions(geographyOptions),
    [geographyOptions],
  );

  // The Designation dropdown mirrors the exact designation strings stored on the
  // leads rows. User-added custom designations are rendered separately via
  // customOptions so they keep their remove (×) affordance.
  const designationSelectOptions = designationOptions;

  const removeCustomDesignation = (value: string) => {
    setCustomDesignations((prev) => prev.filter((x) => x !== value));
    void removeCustomFilterOption('designation', value).then((res) => {
      if (res.error) onToast(`Could not remove "${value}": ${res.error}`, 'error');
    });
  };

  // ─── FILTERED + SORTED ROWS ───
  const filteredLeads = useMemo(() => {
    let result = leads;

    const q = searchVal.trim().toLowerCase();
    if (q) {
      result = result.filter((l) => {
        const haystack = [l.full_name, l.email, l.company_name]
          .map((v) => (v || '').toLowerCase())
          .join(' ');
        return haystack.includes(q);
      });
    }

    if (nameFilter) {
      result = result.filter((l) =>
        (l.full_name || '').toLowerCase().includes(nameFilter.toLowerCase()),
      );
    }

    if (emailFilter) {
      result = result.filter((l) =>
        (l.email || '').toLowerCase().includes(emailFilter.toLowerCase()),
      );
    }

    if (phoneFilter) {
      result = result.filter((l) => (l.phone || '').includes(phoneFilter));
    }

    if (companyFilter) {
      result = result.filter((l) => matchColumn(l.company_name, companyFilter));
    }

    if (designationFilter) {
      result = result.filter((l) => matchColumn(l.designation, designationFilter));
    }

    if (industryFilter) {
      result = result.filter((l) => matchColumn(l.industry, industryFilter));
    }

    if (geographyFilter) {
      result = result.filter((l) =>
        matchColumn(l.geography || l.location, geographyFilter),
      );
    }

    result = [...result].sort((a, b) => {
      const valA = (a[sortKey] || '').toString().toLowerCase();
      const valB = (b[sortKey] || '').toString().toLowerCase();
      if (valA < valB) return -1 * sortDir;
      if (valA > valB) return 1 * sortDir;
      return 0;
    });

    return result;
  }, [leads, searchVal, nameFilter, emailFilter, phoneFilter, companyFilter, designationFilter, industryFilter, geographyFilter, sortKey, sortDir]);

  const totalPages = Math.ceil(filteredLeads.length / pageSize) || 1;
  const safePage = Math.min(page, totalPages);

  const paginatedLeads = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredLeads.slice(start, start + pageSize);
  }, [filteredLeads, safePage, pageSize]);

  // ─── SORT HANDLER ───
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
    setPage(1);
  };

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (
      <span className="ct-sort-arrow">{sortDir === 1 ? '↑' : '↓'}</span>
    ) : null;

  const activeFilterCount = [
    nameFilter,
    emailFilter,
    phoneFilter,
    companyFilter,
    designationFilter,
    industryFilter,
    geographyFilter,
  ].filter(Boolean).length;

  const clearAllFilters = () => {
    setNameFilter('');
    setEmailFilter('');
    setPhoneFilter('');
    setCompanyFilter('');
    setDesignationFilter('');
    setIndustryFilter('');
    setGeographyFilter('');
    setPage(1);
  };

  // ─── EDIT MODAL OPENER ───
  const openEdit = (lead: LeadRow) => {
    setEditLead(lead);
    setFName(lead.full_name || '');
    setFEmail(lead.email || '');
    setFPhone(lead.phone || '');
    setFCompany(lead.company_name || '');
    setFDesig(lead.designation || '');
    setFIndustry(lead.industry || '');
    setFGeography(lead.geography || '');
    setFLinkedin(lead.linkedin_url || '');
  };

  // ─── EDIT SUBMIT ───
  const handleSubmitEdit = async () => {
    if (submitting || !editLead) return;
    if (!fName.trim()) {
      onToast('Full name is required', 'error');
      return;
    }
    if (fEmail.trim() && !emailValid(fEmail)) {
      onToast('Please enter a valid email address', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase
        .from('leads')
        .update({
          full_name: fName.trim(),
          email: fEmail.trim() || null,
          phone: fPhone.trim() || null,
          company_name: fCompany.trim() || null,
          designation: fDesig.trim() || null,
          industry: fIndustry.trim() || null,
          geography: fGeography.trim() || null,
          linkedin_url: fLinkedin.trim() || null,
        })
        .eq('id', editLead.id);

      if (error) {
        onToast('Failed to update lead: ' + error.message, 'error');
        return;
      }

      setEditLead(null);
      onToast('Lead updated successfully', 'success');
      setLoading(true);
      await fetchLeads();
    } catch (e: any) {
      onToast('Failed to update lead: ' + (e?.message || e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ─── DELETE ───
  // Deleting from public.leads fires the AFTER DELETE trigger, which also
  // removes the mirrored contact from Contacts → "lead search" automatically.
  const handleConfirmDelete = async () => {
    if (submitting || !deleteTarget) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.from('leads').delete().eq('id', deleteTarget.id);
      if (error) {
        onToast('Failed to delete lead: ' + error.message, 'error');
        return;
      }
      setDeleteTarget(null);
      onToast('Lead deleted', 'success');
      setLeads((prev) => prev.filter((l) => l.id !== deleteTarget.id));
    } catch (e: any) {
      onToast('Failed to delete lead: ' + (e?.message || e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ─── VIEW MODAL DETAIL ROWS ───
  const detailRows = useMemo(() => {
    if (!viewLead) return [];
    const l = viewLead;
    return [
      { label: 'Full Name', value: l.full_name || '—' },
      { label: 'Email', value: l.email || '—' },
      { label: 'Phone', value: l.phone || '—' },
      { label: 'Company', value: l.company_name || '—' },
      { label: 'Designation', value: l.designation || '—' },
      { label: 'Job Title', value: l.job_title || '—' },
      { label: 'Role', value: l.role || '—' },
      { label: 'Headline', value: l.headline || '—' },
      { label: 'Industry', value: l.industry || '—' },
      { label: 'Geography', value: l.geography || '—' },
      { label: 'Location', value: l.location || '—' },
      { label: 'Source Query', value: l.source_query || '—' },
      {
        label: 'Phone Lookup Attempted',
        value: l.phone_attempted ? 'Yes' : 'No',
      },
      {
        label: 'Email Enrichment Attempted',
        value: l.email_attempted ? 'Yes' : 'No',
      },
      { label: 'Created', value: fmtDate(l.created_at) },
      { label: 'Owner User ID', value: l.user_id || '—' },
      { label: 'Record ID', value: l.id },
    ];
  }, [viewLead]);

  return (
    <div className="page active">
      {/* ─── TITLE + ACTIONS ─── */}
      <div className="contacts-head">
        <div>
          <div className="contacts-title">Lead Database</div>
          <div className="contacts-sub">
            Browse and manage every saved lead from Lead Generation.
          </div>
        </div>
      </div>

      {/* ─── TABLE PANEL ─── */}
      <div className="ct-panel">
        {/* Toolbar: search + filters */}
        <div className="ct-toolbar">
          <div>
            <div className="ct-panel-title">Leads</div>
            <div className="ct-record-count">{filteredLeads.length} records</div>
          </div>
          <div className="ct-toolbar-right">
            {activeFilterCount > 0 && (
              <button className="btn btn-ghost ct-clear-filters" onClick={clearAllFilters}>
                Clear all filters ({activeFilterCount})
              </button>
            )}
            <div className="ct-search">
              <span className="ct-search-ic">
                <SearchIcon size={15} />
              </span>
              <input
                type="search"
                value={searchVal}
                onChange={(e) => {
                  setSearchVal(e.target.value);
                  setPage(1);
                }}
                placeholder="Search name, email, company..."
              />
            </div>
            <div style={{ minWidth: 178 }}>
              <SearchableSelect
                value={industryFilter}
                options={industrySelectOptions}
                onChange={(value) => {
                  setIndustryFilter(value);
                  setPage(1);
                }}
                placeholder="All Industries"
              />
            </div>
            <div style={{ minWidth: 178 }}>
              <SearchableSelect
                value={geographyFilter}
                options={geographySelectOptions}
                onChange={(value) => {
                  setGeographyFilter(value);
                  setPage(1);
                }}
                placeholder="All Geographies"
              />
            </div>
          </div>
        </div>

        {/* ─── LEADS TABLE ─── */}
        <div className="ct-table-wrap">
          <table className="ct-table" style={{ minWidth: 1280 }}>
            <thead>
              <tr>
                <th className="ct-sortable" onClick={() => handleSort('full_name')}>
                  Name {sortArrow('full_name')}
                  {nameFilter && <span className="ct-filter-dot" />}
                </th>
                <th>
                  Email{emailFilter && <span className="ct-filter-dot" />}
                </th>
                <th>
                  Phone{phoneFilter && <span className="ct-filter-dot" />}
                </th>
                <th className="ct-sortable" onClick={() => handleSort('company_name')}>
                  Company {sortArrow('company_name')}
                  {companyFilter && <span className="ct-filter-dot" />}
                </th>
                <th>
                  Designation{designationFilter && <span className="ct-filter-dot" />}
                </th>
                <th className="ct-sortable" onClick={() => handleSort('industry')}>
                  Industry {sortArrow('industry')}
                  {industryFilter && <span className="ct-filter-dot" />}
                </th>
                <th>
                  Geography{geographyFilter && <span className="ct-filter-dot" />}
                </th>
                <th>LinkedIn</th>
                <th className="ct-sortable" onClick={() => handleSort('created_at')}>
                  Created {sortArrow('created_at')}
                </th>
                <th style={{ textAlign: 'right', width: 116 }}>Actions</th>
              </tr>
              <tr className="ct-filter-row">
                <th>
                  <input
                    type="search"
                    className="ct-select ct-filter-ctl"
                    placeholder="Filter name"
                    value={nameFilter}
                    onChange={(e) => {
                      setNameFilter(e.target.value);
                      setPage(1);
                    }}
                  />
                </th>
                <th />
                <th />
                <th>
                  <SearchableSelect
                    value={companyFilter}
                    options={companySelectOptions}
                    onChange={(value) => {
                      setCompanyFilter(value);
                      setPage(1);
                    }}
                    placeholder="All Companies"
                  />
                </th>
                <th>
                  <SearchableSelect
                    value={designationFilter}
                    options={designationSelectOptions}
                    customOptions={customDesignations}
                    onRemoveCustom={removeCustomDesignation}
                    onChange={(value) => {
                      setDesignationFilter(value);
                      setPage(1);
                    }}
                    placeholder="All Designations"
                  />
                </th>
                <th>
                  <SearchableSelect
                    value={industryFilter}
                    options={industrySelectOptions}
                    onChange={(value) => {
                      setIndustryFilter(value);
                      setPage(1);
                    }}
                    placeholder="All Industries"
                  />
                </th>
                <th>
                  <SearchableSelect
                    value={geographyFilter}
                    options={geographySelectOptions}
                    onChange={(value) => {
                      setGeographyFilter(value);
                      setPage(1);
                    }}
                    placeholder="All Geographies"
                  />
                </th>
                <th />
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <span className="spinner"></span>
                        <span className="empty-title">Loading leads...</span>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : paginatedLeads.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">
                      <div className="empty-icon">🗂️</div>
                      <div className="empty-title">No leads found</div>
                      <div className="empty-sub">
                        {fetchError
                          ? fetchError
                          : 'Try adjusting your search criteria or find new leads in Lead Search.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedLeads.map((l) => {
                  const avatarBg = AV_COLORS[(l.full_name || 'A').charCodeAt(0) % AV_COLORS.length];
                  return (
                    <tr key={l.id}>
                      <td>
                        <div className="ct-name-cell">
                          <div className="ct-avatar" style={{ background: avatarBg }}>
                            {initialsOf(l.full_name || '')}
                          </div>
                          <div className="ct-name-col">
                            <div className="ct-name">{l.full_name || '—'}</div>
                            <div className="ct-sub">{l.headline || l.location || '—'}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="ct-email">{l.email || '—'}</span>
                      </td>
                      <td>
                        <div className="ct-desig">{l.phone || '—'}</div>
                      </td>
                      <td>
                        <div className="ct-cell-main">{l.company_name || '—'}</div>
                      </td>
                      <td>
                        <div className="ct-desig">{l.designation || '—'}</div>
                      </td>
                      <td>
                        <div className="ct-desig">{l.industry || '—'}</div>
                      </td>
                      <td>
                        <div className="ct-desig">{l.geography || l.location || '—'}</div>
                      </td>
                      <td>
                        {l.linkedin_url ? (
                          <a
                            href={l.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: 'var(--accent)',
                              fontSize: '12.5px',
                              fontWeight: 600,
                              textDecoration: 'none',
                              whiteSpace: 'nowrap',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                            onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                          >
                            View Profile
                          </a>
                        ) : (
                          <span className="ct-desig">—</span>
                        )}
                      </td>
                      <td>
                        <div className="ct-desig">{fmtDate(l.created_at)}</div>
                      </td>
                      <td>
                        <div className="ct-row-actions">
                          <button
                            title="View Lead"
                            onClick={() => setViewLead(l)}
                            className="ct-ibtn"
                          >
                            <EyeIcon size={15} />
                          </button>
                          <button
                            title="Edit Lead"
                            onClick={() => openEdit(l)}
                            className="ct-ibtn ct-ibtn-edit"
                          >
                            <EditIcon size={15} />
                          </button>
                          <button
                            title="Delete Lead"
                            onClick={() => setDeleteTarget(l)}
                            className="ct-ibtn ct-ibtn-danger"
                          >
                            <TrashIcon size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ─── PAGINATION FOOTER ─── */}
        {!loading && (
          <div className="ct-foot">
            <div className="ct-sub" style={{ marginTop: 0 }}>
              Showing{' '}
              <span style={{ fontWeight: 600, color: 'var(--text2)' }}>
                {paginatedLeads.length > 0 ? (safePage - 1) * pageSize + 1 : 0}
                {' – '}
                {Math.min(safePage * pageSize, filteredLeads.length)}
              </span>{' '}
              of {filteredLeads.length}
              <span style={{ marginLeft: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor="ld-page-size" style={{ color: 'var(--text4)', fontWeight: 600 }}>
                  Per page
                </label>
                <select
                  id="ld-page-size"
                  className="ct-select"
                  style={{ padding: '6px 26px 6px 10px' }}
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            {totalPages > 1 && (
              <div className="pagination">
                <button
                  disabled={safePage === 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                  className="pg-btn"
                >
                  Previous
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`pg-btn ${p === safePage ? 'active' : ''}`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  disabled={safePage === totalPages}
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                  className="pg-btn"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── MODAL: VIEW LEAD DETAILS ─── */}
      {viewLead && (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-header">
              <div>
                <div className="modal-title">Lead Details</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Full record stored in the leads database
                </div>
              </div>
              <button className="modal-close" onClick={() => setViewLead(null)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                {detailRows.map((row) => (
                  <div className="form-group" key={row.label}>
                    <label>{row.label}</label>
                    <div style={{ fontSize: 13, color: 'var(--text2)', wordBreak: 'break-all' }}>
                      {row.value}
                    </div>
                  </div>
                ))}
                <div className="form-group">
                  <label>LinkedIn Profile</label>
                  {viewLead.linkedin_url ? (
                    <a
                      href={viewLead.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
                    >
                      {viewLead.linkedin_url}
                    </a>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--text2)' }}>—</div>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setViewLead(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: EDIT LEAD ─── */}
      {editLead && (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-header">
              <div>
                <div className="modal-title">Edit Lead</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Update the lead record details
                </div>
              </div>
              <button className="modal-close" onClick={() => setEditLead(null)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group">
                  <label>Full Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Abhishek Rungta"
                    value={fName}
                    onChange={(e) => setFName(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    placeholder="name@company.com"
                    value={fEmail}
                    onChange={(e) => setFEmail(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Phone</label>
                  <input
                    type="text"
                    placeholder="+91 98765 43210"
                    value={fPhone}
                    onChange={(e) => setFPhone(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Company</label>
                  <input
                    type="text"
                    placeholder="e.g. Indus Net Technologies"
                    value={fCompany}
                    onChange={(e) => setFCompany(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Designation</label>
                  <input
                    type="text"
                    placeholder="CEO"
                    value={fDesig}
                    onChange={(e) => setFDesig(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Industry</label>
                  <input
                    type="text"
                    placeholder="IT Services"
                    value={fIndustry}
                    onChange={(e) => setFIndustry(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Geography</label>
                  <input
                    type="text"
                    placeholder="Kolkata, India"
                    value={fGeography}
                    onChange={(e) => setFGeography(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>LinkedIn URL</label>
                  <input
                    type="url"
                    placeholder="https://www.linkedin.com/in/..."
                    value={fLinkedin}
                    onChange={(e) => setFLinkedin(e.target.value)}
                  />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEditLead(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={submitting} onClick={() => void handleSubmitEdit()}>
                {submitting ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: DELETE CONFIRMATION ─── */}
      {deleteTarget && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Delete Lead</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  {deleteTarget.full_name || 'This lead'}
                </div>
              </div>
              <button className="modal-close" onClick={() => setDeleteTarget(null)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.55 }}>
                Are you sure you want to delete this lead? This cannot be undone.
              </div>
              <div
                style={{
                  marginTop: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  color: '#B91C1C',
                  fontSize: 12.5,
                }}
              >
                ⚠️ This will also remove the lead from Contacts → Lead Search.
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setDeleteTarget(null)} disabled={submitting}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={submitting} onClick={() => void handleConfirmDelete()}>
                {submitting ? 'Deleting...' : 'Delete Lead'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}