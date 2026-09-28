import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  createApifyScraper,
  deleteApifyScraper,
  fetchApifyScrapers,
  updateApifyScraper,
  validateScraperName,
  validateScraperUrl,
} from '../services/apifyScrapersService';
import type { ApifyScraper } from '../services/apifyScrapersService';

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

const PlusIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const ExternalIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const EditIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const TrashIcon = ({ size = 14 }: { size?: number }) => (
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

interface ApifyScrapersTabProps {
  onToast: (msg: string, type?: string) => void;
}

const EMPTY_FORM = { name: '', url: '', description: '' };

export default function ApifyScrapersTab({ onToast }: ApifyScrapersTabProps) {
  const [scrapers, setScrapers] = useState<ApifyScraper[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [searchVal, setSearchVal] = useState('');

  // Add / Edit modal state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingScraper, setEditingScraper] = useState<ApifyScraper | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Delete confirmation state
  const [deletingScraper, setDeletingScraper] = useState<ApifyScraper | null>(null);
  const [deleting, setDeleting] = useState(false);

  const applyScrapers = useCallback((data: ApifyScraper[], error: string | null) => {
    if (error) {
      setFetchError(error);
      setScrapers([]);
    } else {
      setFetchError(null);
      setScrapers(data);
    }
  }, []);

  const loadScrapers = useCallback(async () => {
    setLoading(true);
    const { data, error } = await fetchApifyScrapers();
    applyScrapers(data, error);
    setLoading(false);
  }, [applyScrapers]);

  // Initial load. The first setState only runs after the network round-trip,
  // so the effect body never updates state synchronously.
  useEffect(() => {
    let active = true;
    fetchApifyScrapers().then(({ data, error }) => {
      if (!active) return;
      applyScrapers(data, error);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [applyScrapers]);

  const filteredScrapers = useMemo(() => {
    const q = searchVal.trim().toLowerCase();
    if (!q) return scrapers;
    return scrapers.filter((s) =>
      [s.name, s.description ?? '', s.url].some((field) => field.toLowerCase().includes(q)),
    );
  }, [scrapers, searchVal]);

  const openAddModal = () => {
    setEditingScraper(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEditModal = (scraper: ApifyScraper) => {
    setEditingScraper(scraper);
    setForm({ name: scraper.name, url: scraper.url, description: scraper.description ?? '' });
    setFormError(null);
    setIsFormOpen(true);
  };

  const closeFormModal = () => {
    setIsFormOpen(false);
    setEditingScraper(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const handleFormSubmit = async () => {
    const nameError = validateScraperName(form.name);
    if (nameError) {
      setFormError(nameError);
      return;
    }

    const urlResult = validateScraperUrl(form.url);
    if (!urlResult.valid) {
      setFormError(urlResult.message);
      return;
    }

    setSubmitting(true);
    const payload = {
      name: form.name.trim(),
      url: urlResult.url,
      description: form.description.trim(),
    };

    const { error } = editingScraper
      ? await updateApifyScraper(editingScraper.id, payload)
      : await createApifyScraper(payload);

    if (error) {
      setFormError(error);
      setSubmitting(false);
      return;
    }

    closeFormModal();
    onToast(editingScraper ? 'Scraper updated successfully' : 'Scraper saved successfully', 'success');
    await loadScrapers();
    setSubmitting(false);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingScraper) return;
    setDeleting(true);

    const { error } = await deleteApifyScraper(deletingScraper.id);
    if (error) {
      onToast('Failed to delete scraper: ' + error, 'error');
      setDeleting(false);
      return;
    }

    onToast('Scraper deleted', 'success');
    setDeletingScraper(null);
    setDeleting(false);
    await loadScrapers();
  };

  return (
    <div className="page active">
      {/* ─── TITLE + ACTIONS ─── */}
      <div className="contacts-head">
        <div>
          <div className="contacts-title">Apify Scrapers</div>
          <div className="contacts-sub">Manage your Apify scraper links</div>
        </div>
        <div className="ct-toolbar-right" style={{ marginTop: 0 }}>
          <button className="btn btn-primary" onClick={openAddModal}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <PlusIcon size={15} />
              Add Scraper
            </span>
          </button>
        </div>
      </div>

      {/* ─── LIST PANEL ─── */}
      <div className="ct-panel">
        <div className="ct-toolbar">
          <div>
            <div className="ct-panel-title">Apify Scrapers</div>
            <div className="ct-record-count">{filteredScrapers.length} records</div>
          </div>
          <div className="ct-toolbar-right">
            <div className="ct-search">
              <span className="ct-search-ic">
                <SearchIcon size={15} />
              </span>
              <input
                type="search"
                value={searchVal}
                onChange={(e) => setSearchVal(e.target.value)}
                placeholder="Search scrapers..."
                aria-label="Search scrapers"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <span className="spinner"></span>
              <span className="empty-title">Loading Apify scrapers...</span>
            </div>
          </div>
        ) : fetchError ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <div className="empty-icon">⚠️</div>
            <div className="empty-title">Failed to load Apify scrapers</div>
            <div className="empty-sub">{fetchError}</div>
          </div>
        ) : filteredScrapers.length === 0 ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <div className="empty-icon">🕷️</div>
            <div className="empty-title">
              {searchVal.trim() ? 'No scrapers match your search' : 'No Apify scrapers yet'}
            </div>
            <div className="empty-sub">
              {searchVal.trim()
                ? 'Try a different scraper name, description or URL.'
                : 'Click "Add Scraper" to save your first Apify scraper link.'}
            </div>
          </div>
        ) : (
          <div className="ct-table-wrap">
            <table className="ct-table">
              <thead>
                <tr>
                  <th>Scraper Name</th>
                  <th>Description</th>
                  <th>Apify URL</th>
                  <th style={{ textAlign: 'right', width: 220 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredScrapers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="ct-cell-main" style={{ fontWeight: 600 }}>
                        {s.name}
                      </div>
                    </td>
                    <td>
                      <div className="ct-desig" style={{ maxWidth: 260, whiteSpace: 'normal' }}>
                        {s.description || '—'}
                      </div>
                    </td>
                    <td>
                      <div className="ct-email" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.url}
                      </div>
                    </td>
                    <td>
                      <div className="ct-row-actions" style={{ gap: 6 }}>
                        <a
                          className="btn btn-sm btn-secondary"
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open ${s.name} in a new tab`}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <ExternalIcon size={13} />
                            Open
                          </span>
                        </a>
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => openEditModal(s)}
                          title="Edit Scraper"
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <EditIcon size={13} />
                            Edit
                          </span>
                        </button>
                        <button
                          className="btn btn-sm btn-ghost btn-danger"
                          onClick={() => setDeletingScraper(s)}
                          title="Delete Scraper"
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <TrashIcon size={13} />
                            Delete
                          </span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── ADD / EDIT MODAL ─── */}
      {isFormOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">{editingScraper ? 'Edit Scraper' : 'Add Scraper'}</div>
                <div className="contacts-sub" style={{ marginTop: 3 }}>
                  {editingScraper
                    ? 'Update the saved Apify scraper link'
                    : 'Save a link to an Apify scraper you use'}
                </div>
              </div>
              <button className="modal-close" onClick={closeFormModal} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>Scraper Name *</label>
                <input
                  type="text"
                  placeholder="e.g. Profile Scraper"
                  value={form.name}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, name: e.target.value }));
                    if (formError) setFormError(null);
                  }}
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label>Apify URL *</label>
                <input
                  type="url"
                  placeholder="https://apify.com/username/scraper-name"
                  value={form.url}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, url: e.target.value }));
                    if (formError) setFormError(null);
                  }}
                />
              </div>

              <div className="form-group">
                <label>Description (optional)</label>
                <textarea
                  rows={3}
                  placeholder="e.g. Scrapes LinkedIn profile information."
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>

              {formError && (
                <div className="form-error" style={{ color: 'var(--red)', fontSize: '12px' }}>
                  {formError}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={closeFormModal} disabled={submitting}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleFormSubmit}
                disabled={submitting || !form.name.trim() || !form.url.trim()}
              >
                {submitting ? 'Saving...' : editingScraper ? 'Save Changes' : 'Save Scraper'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── DELETE CONFIRMATION MODAL ─── */}
      {deletingScraper && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Delete Scraper</div>
                <div className="contacts-sub" style={{ marginTop: 3 }}>
                  Are you sure you want to delete this scraper?
                </div>
              </div>
              <button
                className="modal-close"
                onClick={() => setDeletingScraper(null)}
                title="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div style={{ color: 'var(--text2)', marginBottom: 16 }}>
                <strong>{deletingScraper.name}</strong> ({deletingScraper.url}) will be removed. This
                action cannot be undone.
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setDeletingScraper(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
