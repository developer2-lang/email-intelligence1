import { useState, useEffect, useCallback } from 'react';
import { fetchAllContactTypes, updateContactType, deleteContactType, getContactCountByType } from '../services/contactTypesService';
import type { ContactType } from '../services/contactTypesService';
import { getLeadCount } from '../services/leadsService';
import { LEAD_MIRROR_TAB } from '../constants/constants';

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const EditIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const TrashIcon = ({ size = 16 }: { size?: number }) => (
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

interface ContactTypesTabProps {
  onToast: (msg: string, type?: string) => void;
}

export default function ContactTypesTab({ onToast }: ContactTypesTabProps) {
  const [contactTypes, setContactTypes] = useState<ContactType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contactCounts, setContactCounts] = useState<Record<string, number>>({});

  // Edit modal state
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingContactType, setEditingContactType] = useState<ContactType | null>(null);
  const [editName, setEditName] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete confirmation state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const loadContactTypes = useCallback(async () => {
    setLoading(true);
    const { data, error } = await fetchAllContactTypes();
    if (error) {
      setError(error);
      setContactTypes([]);
      onToast('Failed to load contact types: ' + error, 'error');
    } else {
      setError(null);
      setContactTypes(data || []);
      // Fetch counts for each type. The lead-search mirror row counts LIVE leads
      // (public.leads); every other row counts contacts of that type.
      for (const ct of data || []) {
        const { count } = ct.name.toLowerCase() === LEAD_MIRROR_TAB.toLowerCase()
          ? await getLeadCount()
          : await getContactCountByType(ct.name);
        setContactCounts(prev => ({ ...prev, [ct.name]: count }));
      }
    }
    setLoading(false);
  }, [onToast]);

  useEffect(() => {
    loadContactTypes();
  }, [loadContactTypes]);

  const handleOpenEdit = (ct: ContactType) => {
    setEditingContactType(ct);
    setEditName(ct.name);
    setEditIsActive(ct.is_active);
    setEditError(null);
    setIsEditModalOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editingContactType) return;
    const name = editName.trim();
    if (!name) {
      setEditError('Name is required');
      return;
    }

    // Check for duplicate (case-insensitive)
    const isDuplicate = contactTypes.some(
      ct => ct.id !== editingContactType.id && ct.name.toLowerCase() === name.toLowerCase()
    );
    if (isDuplicate) {
      setEditError('A contact list with this name already exists');
      return;
    }

    setEditSubmitting(true);
    setEditError(null);

    const { error } = await updateContactType(editingContactType.id, { name, is_active: editIsActive });
    if (error) {
      setEditError(error);
      setEditSubmitting(false);
      return;
    }

    setIsEditModalOpen(false);
    setEditingContactType(null);
    onToast('Contact list updated successfully', 'success');
    await loadContactTypes();
    setEditSubmitting(false);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingId) return;
    setShowDeleteConfirm(false);

    const { error } = await deleteContactType(deletingId);
    if (error) {
      onToast('Failed to delete contact list: ' + error, 'error');
      setDeletingId(null);
      return;
    }

    onToast('Contact list deleted', 'success');
    await loadContactTypes();
    setDeletingId(null);
  };

  const handleOpenDeleteConfirm = (id: string) => {
    setDeletingId(id);
    setShowDeleteConfirm(true);
  };

  const getStatusBadge = (isActive: boolean) => (
    <span className={`tag ${isActive ? 'tag-client' : 'tag-draft'}`} style={{ fontSize: '11px' }}>
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );

  return (
    <div className="page active">
      <div className="contacts-head">
        <div>
          <div className="contacts-title">Contact Types</div>
          <div className="contacts-sub">
            Manage contact type definitions used for segmentation and filtering
          </div>
        </div>
      </div>

      <div className="ct-panel">
        {loading ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <span className="spinner"></span>
              <span className="empty-title">Loading contact types...</span>
            </div>
          </div>
        ) : error ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <div className="empty-icon">⚠️</div>
            <div className="empty-title">Failed to load contact types</div>
            <div className="empty-sub">{error}</div>
          </div>
        ) : contactTypes.length === 0 ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <div className="empty-icon">📋</div>
            <div className="empty-title">No contact types found</div>
            <div className="empty-sub">Contact types will appear here once created</div>
          </div>
        ) : (
          <>
            <div className="ct-table-wrap">
              <table className="ct-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}></th>
                    <th className="ct-sortable">Name</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'center', width: 120 }}>Contacts</th>
                    <th style={{ textAlign: 'center', width: 140 }}>Created</th>
                    <th style={{ textAlign: 'right', width: 120 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contactTypes.map((ct) => (
                    <tr key={ct.id}>
                      <td>
                        <span className="tag tag-default" style={{ fontSize: '11px' }}>
                          {ct.name.toLowerCase() === LEAD_MIRROR_TAB.toLowerCase() ? 'Lead' :
                           ct.name === 'Existing Client' ? 'Client' :
                           ct.name === 'New Lead' ? 'Lead' :
                           ct.name === 'Prospect' ? 'Prospect' :
                           ct.name === 'Newsletter' ? 'News' :
                           ct.name === 'Partner' ? 'Partner' : 'List'}
                        </span>
                      </td>
                      <td>
                        <div className="ct-cell-main" style={{ fontWeight: 500 }}>{ct.name}</div>
                      </td>
                      <td>{getStatusBadge(ct.is_active)}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--text2)' }}>
                        {contactCounts[ct.name] ?? 0}
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--text3)', fontSize: '12px' }}>
                        {ct.created_at ? new Date(ct.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td>
                        <div className="ct-row-actions" style={{ justifyContent: 'flex-end' }}>
                          <button
                            title="Edit Contact List"
                            onClick={() => handleOpenEdit(ct)}
                            className="ct-ibtn ct-ibtn-edit"
                            disabled={editSubmitting}
                          >
                            <EditIcon size={15} />
                          </button>
                          <button
                            title="Delete Contact List"
                            onClick={() => handleOpenDeleteConfirm(ct.id)}
                            className="ct-ibtn ct-ibtn-danger"
                            disabled={deletingId !== null}
                          >
                            <TrashIcon size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ─── EDIT MODAL ─── */}
      {isEditModalOpen && editingContactType && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Edit Contact List</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Update the contact list details
                </div>
              </div>
              <button className="modal-close" onClick={() => { setIsEditModalOpen(false); setEditingContactType(null); }} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>List Name *</label>
                <input
                  type="text"
                  placeholder="e.g. New Partner Leads"
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    if (editError) setEditError(null);
                  }}
                  autoFocus
                />
                {editError && (
                  <div className="form-error" style={{ color: 'var(--red)', fontSize: '12px', marginTop: 4 }}>
                    {editError}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={editIsActive}
                    onChange={(e) => setEditIsActive(e.target.checked)}
                  />
                  <span>Active</span>
                </label>
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => { setIsEditModalOpen(false); setEditingContactType(null); }}
                disabled={editSubmitting}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={editSubmitting || !editName.trim()}
                onClick={handleEditSubmit}
              >
                {editSubmitting ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── DELETE CONFIRMATION MODAL ─── */}
      {showDeleteConfirm && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Delete Contact List</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Are you sure you want to delete this contact list?
                </div>
              </div>
              <button className="modal-close" onClick={() => { setShowDeleteConfirm(false); setDeletingId(null); }} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div style={{ color: 'var(--text2)', marginBottom: 16 }}>
                This action cannot be undone. The contact list will be removed, but
                existing contacts assigned to this list will not be deleted.
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => { setShowDeleteConfirm(false); setDeletingId(null); }}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDeleteConfirm}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}