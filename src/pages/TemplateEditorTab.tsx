import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmailTemplate } from '../types/campaign';
import type { TabKey } from '../types';
import {
  createEmailTemplate,
  deleteEmailTemplate,
  fetchTemplates,
  updateEmailTemplate,
  uploadEmailTemplate,
} from '../services/campaignService';
import TemplateVisualEditor, {
  MOBILE_RESPONSIVE_CSS,
  type TemplateVisualEditorHandle,
} from '../components/TemplateVisualEditor';
import { toEmailSafeHtml } from '../utils/emailRender';
import { resolveTemplateHtml } from '../services/templateResolve';
import { TemplateThumb } from '../components/TemplateThumb';
import { consumeEditorIntent } from '../services/templateBridge';

interface TemplateEditorTabProps {
  onToast: (msg: string, type?: string) => void;
  onNavigate: (tab: TabKey) => void;
}

const DEFAULT_TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Template</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F3F4F6;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color: #F3F4F6;">
    <tr>
      <td align="center" style="background-color: #F3F4F6; padding: 32px 16px;">
        <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width: 600px; background-color: #FFFFFF; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="padding: 32px;">
              <h1 style="margin: 0 0 12px; font-family: Arial, Helvetica, sans-serif; font-size: 24px; color: #1F2937;">New Template</h1>
              <p style="margin: 0 0 12px; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.7; color: #374151;">Hi {{first_name}},</p>
              <p style="margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.7; color: #374151;">Start editing this email by dragging blocks from the left panel, or click this text to edit it directly.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

/**
 * Resolve the stored HTML for a template through the EXISTING template
 * architecture. The implementation lives in `services/templateResolve` so the
 * All Templates page and this editor share the exact same resolution logic.
 */

function formatCreatedDate(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  borderRadius: '8px',
  border: active ? '1px solid #2563EB' : '1px solid #E2E8F0',
  background: active ? '#EFF6FF' : '#FFFFFF',
  color: active ? '#1D4ED8' : '#475569',
  fontSize: '12.5px',
  fontWeight: 600,
  cursor: 'pointer',
});

function SavedTemplatesSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            padding: '14px',
            border: '1px solid #E5E7EB',
            borderRadius: '12px',
            background: '#FFFFFF',
          }}
        >
          <div
            className="seqb-skeleton"
            style={{ width: '150px', height: '120px', borderRadius: '8px', flexShrink: 0 }}
          />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div className="seqb-skeleton" style={{ width: '45%', height: '14px', borderRadius: '6px' }} />
            <div className="seqb-skeleton" style={{ width: '30%', height: '12px', borderRadius: '6px' }} />
            <div className="seqb-skeleton" style={{ width: '60px', height: '18px', borderRadius: '999px' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' }}>
            <div className="seqb-skeleton" style={{ width: '120px', height: '30px', borderRadius: '8px' }} />
            <div className="seqb-skeleton" style={{ width: '70px', height: '30px', borderRadius: '8px' }} />
          </div>
        </div>
      ))}
      <div
        style={{
          textAlign: 'center',
          fontSize: '12.5px',
          color: '#64748B',
          marginTop: '4px',
        }}
      >
        Loading templates…
      </div>
    </div>
  );
}

export default function TemplateEditorTab({ onToast, onNavigate }: TemplateEditorTabProps) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);

  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [templateLoadingId, setTemplateLoadingId] = useState<string | null>(null);
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<'visual' | 'html'>('visual');
  const [htmlContent, setHtmlContent] = useState(DEFAULT_TEMPLATE_HTML);
  const [dirty, setDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);

  const [fullscreen, setFullscreen] = useState(false);

  // Apply the full-screen layout mode globally so the app sidebar, topbar and
  // page chrome are hidden while the editor fills the viewport. The editor
  // state is untouched — this is purely presentational.
  useEffect(() => {
    const root = document.documentElement;
    if (fullscreen) root.classList.add('te-fs-mode');
    else root.classList.remove('te-fs-mode');
    return () => root.classList.remove('te-fs-mode');
  }, [fullscreen]);

  // Best-effort browser fullscreen. If the Fullscreen API is unavailable (or
  // rejects, e.g. inside a sandboxed iframe) the app-level layout still works.
  useEffect(() => {
    const el = document.documentElement;
    if (fullscreen) {
      if (typeof el.requestFullscreen === 'function' && !document.fullscreenElement) {
        void el.requestFullscreen().catch(() => {});
      }
    } else if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      void document.exitFullscreen().catch(() => {});
    }
  }, [fullscreen]);

  // If the user presses Esc, the browser exits fullscreen — sync the UI back.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [previewHtml, setPreviewHtml] = useState('');

  const displayPreviewHtml = useMemo(() => {
    if (previewDevice !== 'mobile' || !previewHtml) return previewHtml;
    const mobileStyle = `<style>${MOBILE_RESPONSIVE_CSS}</style>`;
    if (/<head[\s>]/i.test(previewHtml)) {
      return previewHtml.replace(/<\/head>/i, `${mobileStyle}</head>`);
    }
    if (/<body[\s>]/i.test(previewHtml)) {
      return previewHtml.replace(/<body([\s>])/i, `${mobileStyle}<body$1`);
    }
    return `${mobileStyle}${previewHtml}`;
  }, [previewHtml, previewDevice]);

  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsMode, setSaveAsMode] = useState<'new' | 'copy'>('new');
  const [saveAsName, setSaveAsName] = useState('');
  const [savingAs, setSavingAs] = useState(false);

  const [unsavedAction, setUnsavedAction] = useState<(() => void) | null>(null);

  const editorRef = useRef<TemplateVisualEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadedHtmlRef = useRef(DEFAULT_TEMPLATE_HTML);
  const [thumbnailHtml, setThumbnailHtml] = useState<Record<string, string>>({});
  const thumbnailResolvedRef = useRef<Set<string>>(new Set());

  // ─── Saved Templates section state ───
  const [savedSearch, setSavedSearch] = useState('');
  const [showAllSaved, setShowAllSaved] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EmailTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    const { data, error } = await fetchTemplates();
    if (error) {
      setTemplatesError(error);
    } else {
      setTemplates(data);
    }
    setTemplatesLoading(false);
  }, []);

  useEffect(() => {
    // Deferred so the loading setState does not run synchronously inside the
    // effect body (mirrors the pattern used across the other tabs).
    const timer = window.setTimeout(() => {
      void loadTemplates();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadTemplates]);

  // When the user arrives from the All Templates page (Edit a template, or
  // start a New Template), load that exact template into the EXISTING editor
  // or begin a blank one. The All Templates page passes the intent through the
  // shared bridge; this editor never duplicates the template HTML.
  useEffect(() => {
    const intent = consumeEditorIntent();
    if (intent.isNew) {
      startNewTemplate();
    } else if (intent.template) {
      void loadTemplateIntoEditor(intent.template);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the saved-template thumbnails from the real stored HTML so the
  // Saved Templates section always shows the actual template content. Storage
  // templates fetch their file; database templates use the `body` column.
  useEffect(() => {
    if (templatesLoading) return;
    let cancelled = false;
    for (const t of templates) {
      if (thumbnailResolvedRef.current.has(t.id)) continue;
      thumbnailResolvedRef.current.add(t.id);
      resolveTemplateHtml(t)
        .then((html) => {
          if (cancelled) return;
          setThumbnailHtml((prev) => ({ ...prev, [t.id]: toEmailSafeHtml(html) }));
        })
        .catch(() => {
          if (cancelled) return;
          setThumbnailHtml((prev) => ({ ...prev, [t.id]: '' }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [templates, templatesLoading]);

  const getCurrentHtml = useCallback((): string => {
    if (mode === 'visual' && editorRef.current) {
      const html = editorRef.current.getHtml();
      if (html) return html;
    }
    return htmlContent;
  }, [mode, htmlContent]);

  const handleVisualChange = useCallback((html: string) => {
    setHtmlContent(html);
    if (html !== loadedHtmlRef.current) setDirty(true);
  }, []);

  const handleHtmlTextareaChange = (value: string) => {
    setHtmlContent(value);
    if (value !== loadedHtmlRef.current) setDirty(true);
  };

  const loadTemplateIntoEditor = useCallback(
    async (t: EmailTemplate) => {
      setTemplateLoadingId(t.id);
      setTemplateLoadError(null);
      try {
        const raw = await resolveTemplateHtml(t);
        // Normalize through the same single-centered-container pipeline used at
        // send time so the editor canvas, previews and the saved structure all
        // show the email the way it will actually be sent (one content card on
        // the email background — never stray blocks on the background or a
        // second white box around an image).
        const html = toEmailSafeHtml(raw);
        loadedHtmlRef.current = html;
        setHtmlContent(html);
        setSelectedTemplate(t);
        setMode('visual');
        setEditorKey((k) => k + 1);
        setDirty(false);
        onToast(`Template '${t.name}' loaded successfully.`, 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load template.';
        setTemplateLoadError(msg);
        onToast(msg, 'error');
      } finally {
        setTemplateLoadingId(null);
      }
    },
    [onToast]
  );

  const handleSelectTemplate = useCallback(
    (t: EmailTemplate) => {
      if (dirty) {
        setUnsavedAction(() => () => void loadTemplateIntoEditor(t));
        return;
      }
      void loadTemplateIntoEditor(t);
    },
    [dirty, loadTemplateIntoEditor]
  );

  const openLibrary = () => {
    setLibraryOpen(true);
    for (const t of templates) {
      if (thumbnailHtml[t.id]) continue;
      resolveTemplateHtml(t)
        .then((html) => {
          setThumbnailHtml((prev) => ({ ...prev, [t.id]: toEmailSafeHtml(html) }));
        })
        .catch(() => {
          setThumbnailHtml((prev) => ({ ...prev, [t.id]: '' }));
        });
    }
  };

  const startNewTemplate = () => {
    const proceed = () => {
      const html = toEmailSafeHtml(DEFAULT_TEMPLATE_HTML);
      loadedHtmlRef.current = html;
      setSelectedTemplate(null);
      setHtmlContent(html);
      setEditorKey((k) => k + 1);
      setMode('visual');
      setDirty(false);
      setTemplateLoadError(null);
      onToast('New blank template created.', 'info');
    };
    if (dirty) setUnsavedAction(() => proceed);
    else proceed();
  };

  const handleUploadTemplate = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await uploadEmailTemplate(file);
      setTemplates((prev) => [...prev, uploaded].sort((a, b) => a.name.localeCompare(b.name)));
      await loadTemplateIntoEditor(uploaded);
      onToast(`Template '${uploaded.name}' uploaded successfully.`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to upload template';
      setUploadError(msg);
      onToast(msg, 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveTemplate = async () => {
    if (saving || savingAs) return;
    const html = getCurrentHtml();
    if (!html.trim()) {
      onToast('The template body is empty and cannot be saved.', 'error');
      return;
    }
    if (!selectedTemplate) {
      setSaveAsMode('new');
      setSaveAsName('Untitled Template');
      setSaveAsOpen(true);
      return;
    }
    setSaving(true);
    try {
      const updated = await updateEmailTemplate(selectedTemplate, html);
      setSelectedTemplate(updated);
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      loadedHtmlRef.current = html;
      setDirty(false);
      onToast(`Template '${updated.name}' saved successfully.`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save template';
      onToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const openSaveAs = () => {
    setSaveAsMode('copy');
    setSaveAsName(selectedTemplate ? `${selectedTemplate.name} (Copy)` : 'Untitled Template');
    setSaveAsOpen(true);
  };

  const confirmSaveAs = async () => {
    const name = saveAsName.trim();
    if (!name) {
      onToast('Template name is required.', 'warn');
      return;
    }
    const html = getCurrentHtml();
    if (!html.trim()) {
      onToast('The template body is empty and cannot be saved.', 'error');
      return;
    }
    setSavingAs(true);
    try {
      const created = await createEmailTemplate(name, html);
      setTemplates((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      loadedHtmlRef.current = html;
      setSelectedTemplate(created);
      setHtmlContent(html);
      setDirty(false);
      setSaveAsOpen(false);
      onToast(`Template '${created.name}' saved successfully.`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save template';
      onToast(msg, 'error');
    } finally {
      setSavingAs(false);
    }
  };

  const openPreview = () => {
    setPreviewHtml(toEmailSafeHtml(getCurrentHtml()));
    setPreviewDevice('desktop');
    setPreviewOpen(true);
  };

  // Open the existing preview modal with a SAVED template's actual HTML.
  const openPreviewForTemplate = useCallback(
    async (t: EmailTemplate) => {
      try {
        const html = await resolveTemplateHtml(t);
        setPreviewHtml(toEmailSafeHtml(html));
        setPreviewDevice('desktop');
        setPreviewOpen(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to preview template.';
        onToast(msg, 'error');
      }
    },
    [onToast]
  );

  // Edit a saved template: load it into the existing TemplateVisualEditor.
  const editSavedTemplate = useCallback(
    (t: EmailTemplate) => {
      handleSelectTemplate(t);
      if (!fullscreen) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [handleSelectTemplate, fullscreen]
  );

  // Confirm + perform a saved-template delete from the Supabase `templates` table.
  const confirmDeleteSaved = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const result = await deleteEmailTemplate(deleteTarget);
      if (!result.ok) {
        if (result.inUse) {
          onToast(
            `Template '${deleteTarget.name}' is used by a campaign and cannot be deleted.`,
            'error'
          );
        } else {
          onToast(result.error || 'Failed to delete template.', 'error');
        }
        setDeleteTarget(null);
        return;
      }
      thumbnailResolvedRef.current.delete(deleteTarget.id);
      setThumbnailHtml((prev) => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      await loadTemplates();
      onToast(`Template '${deleteTarget.name}' deleted successfully.`, 'success');
      setDeleteTarget(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete template.';
      onToast(msg, 'error');
    } finally {
      setDeleting(false);
    }
  };

  // Newest-first ordering for the Saved Templates list (uses updated_at when
  // present, falling back to created_at). Does not mutate the source array.
  const savedTemplatesSorted = [...templates].sort((a, b) => {
    const da = new Date(a.updated_at || a.created_at || 0).getTime();
    const db = new Date(b.updated_at || b.created_at || 0).getTime();
    return db - da;
  });

  const savedTemplatesFiltered = savedSearch.trim()
    ? savedTemplatesSorted.filter((t) =>
        t.name.toLowerCase().includes(savedSearch.trim().toLowerCase())
      )
    : savedTemplatesSorted;

  const INITIAL_SAVED_COUNT = 3;
  const searching = savedSearch.trim().length > 0;
  const savedVisible =
    showAllSaved || searching
      ? savedTemplatesFiltered
      : savedTemplatesFiltered.slice(0, INITIAL_SAVED_COUNT);

  const switchToHtml = () => {
    if (mode === 'html') return;
    const current = editorRef.current?.getHtml();
    if (current) {
      setHtmlContent(current);
      if (current !== loadedHtmlRef.current) setDirty(true);
    }
    setMode('html');
  };

  const switchToVisual = () => {
    if (mode === 'visual') return;
    setMode('visual');
    setEditorKey((k) => k + 1);
  };

  const toolButton: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 14px',
    borderRadius: '9px',
    border: '1px solid #E2E8F0',
    background: '#FFFFFF',
    color: '#334155',
    fontSize: '12.5px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'background 0.15s ease, border-color 0.15s ease',
  };

  return (
    <div className={fullscreen ? 'page active te-fs-page' : 'page active'}>
      {!fullscreen && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '14px',
            flexWrap: 'wrap',
            marginBottom: '16px',
          }}
        >
          <div>
            <div style={{ fontSize: '18px', fontWeight: 700 }}>Template Editor</div>
            <div style={{ fontSize: '12px', color: 'var(--text4)', marginTop: '2px' }}>
              Create, upload, edit and save email templates visually
            </div>
            {selectedTemplate && (
              <div style={{ fontSize: '11.5px', color: '#64748B', marginTop: '6px' }}>
                Editing:{' '}
                <span style={{ fontWeight: 700, color: '#1D4ED8' }}>{selectedTemplate.name}</span>
                {selectedTemplate.created_at
                  ? ` · created ${formatCreatedDate(selectedTemplate.created_at)}`
                  : ''}
                {dirty && (
                  <span style={{ color: '#B45309', marginLeft: '6px' }}>● unsaved changes</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Template management toolbar ─── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          marginBottom: '14px',
          padding: '12px 14px',
          border: '1px solid #E2E8F0',
          borderRadius: '12px',
          background: '#FFFFFF',
        }}
      >
        <button type="button" style={toolButton} onClick={openLibrary} disabled={templatesLoading}>
          📂 Select Template
        </button>
        <button type="button" style={toolButton} onClick={() => onNavigate('template-library')}>
          📁 All Templates
        </button>
        <button type="button" style={toolButton} onClick={startNewTemplate}>
          + New Template
        </button>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept=".html,.htm,text/html"
          onChange={(e) => void handleUploadTemplate(e.target.files)}
        />
        <button
          type="button"
          style={{ ...toolButton, color: '#1D4ED8', borderColor: '#BFDBFE', background: '#EFF6FF' }}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading template…' : 'Upload HTML Template'}
        </button>

        <span style={{ width: 1, height: 22, background: '#E2E8F0', margin: '0 4px' }} aria-hidden="true" />

        <button
          type="button"
          style={{
            ...toolButton,
            color: '#FFFFFF',
            background: '#2563EB',
            borderColor: '#2563EB',
            opacity: saving ? 0.75 : 1,
          }}
          onClick={() => void handleSaveTemplate()}
          disabled={saving || templateLoadingId !== null}
        >
          {saving ? 'Saving…' : 'Save Template'}
        </button>
        <button type="button" style={toolButton} onClick={openSaveAs} disabled={saving || savingAs}>
          Save As
        </button>

        <span style={{ width: 1, height: 22, background: '#E2E8F0', margin: '0 4px' }} aria-hidden="true" />

        <button type="button" style={toolButton} onClick={openPreview}>
          Preview
        </button>

        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: '6px' }}>
          <button type="button" style={tabBtn(mode === 'visual')} onClick={switchToVisual}>
            Visual
          </button>
          <button type="button" style={tabBtn(mode === 'html')} onClick={switchToHtml}>
            HTML
          </button>
        </div>
      </div>

      {!fullscreen && templatesError && (
        <div
          style={{
            marginBottom: '12px',
            padding: '10px 14px',
            borderRadius: '10px',
            background: '#FEF2F2',
            border: '1px solid #FECACA',
            color: '#B91C1C',
            fontSize: '12.5px',
          }}
        >
          Unable to load templates: {templatesError}{' '}
          <button
            className="btn btn-xs"
            style={{ marginLeft: '8px' }}
            onClick={() => void loadTemplates()}
          >
            Retry
          </button>
        </div>
      )}

      {!fullscreen && uploadError && (
        <div
          style={{
            marginBottom: '12px',
            padding: '10px 14px',
            borderRadius: '10px',
            background: '#FEF2F2',
            border: '1px solid #FECACA',
            color: '#B91C1C',
            fontSize: '12.5px',
          }}
        >
          Unable to upload template — {uploadError}
        </div>
      )}

      {!fullscreen && templateLoadError && (
        <div
          style={{
            marginBottom: '12px',
            padding: '10px 14px',
            borderRadius: '10px',
            background: '#FFFBEB',
            border: '1px solid #FDE68A',
            color: '#92400E',
            fontSize: '12.5px',
          }}
        >
          {templateLoadError}
        </div>
      )}

      {/* ─── Editor area ─── */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          flex: fullscreen ? '1 1 auto' : undefined,
        }}
      >
        {templateLoadingId !== null ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              minHeight: '420px',
              border: '1px solid #E2E8F0',
              borderRadius: '14px',
              background: '#FFFFFF',
            }}
          >
            <span className="seqb-spin" style={{ fontSize: '30px', color: '#2563EB' }}>
              ⟳
            </span>
            <div style={{ fontSize: '13px', color: '#64748B' }}>Loading template…</div>
          </div>
        ) : mode === 'visual' ? (
          <TemplateVisualEditor
            key={`visual-${editorKey}`}
            ref={editorRef}
            initialHtml={htmlContent}
            onChange={handleVisualChange}
            onError={(msg) => onToast(msg, 'error')}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((prev) => !prev)}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              minHeight: fullscreen ? 0 : '560px',
              flex: fullscreen ? '1 1 auto' : undefined,
              border: '1px solid #E2E8F0',
              borderRadius: '14px',
              overflow: 'hidden',
              background: '#FFFFFF',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 14px',
                borderBottom: '1px solid #E2E8F0',
                background: '#F8FAFC',
                fontSize: '11.5px',
                color: '#94A3B8',
              }}
            >
              HTML source — placeholders like{' '}
              <span style={{ fontFamily: 'var(--mono)', color: '#1D4ED8' }}>{'{{first_name}}'}</span>{' '}
              must stay unchanged; they are resolved at send time.
            </div>
            <textarea
              value={htmlContent}
              onChange={(e) => handleHtmlTextareaChange(e.target.value)}
              spellCheck={false}
              placeholder="Edit the email template HTML here..."
              style={{
                flex: 1,
                width: '100%',
                minHeight: fullscreen ? 0 : '540px',
                padding: '16px',
                border: 'none',
                outline: 'none',
                resize: 'none',
                fontFamily: 'var(--mono)',
                fontSize: '12.5px',
                lineHeight: 1.55,
                color: '#0F172A',
                background: '#FFFFFF',
                boxSizing: 'border-box',
              }}
            />
          </div>
        )}
      </div>

      {/* ─── Saved Templates section (reads from the same Supabase `templates` table) ─── */}
      {!fullscreen && (
        <section
          style={{
            marginTop: '26px',
            border: '1px solid #E2E8F0',
            borderRadius: '16px',
            background: '#FFFFFF',
            padding: '20px 22px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '14px',
              flexWrap: 'wrap',
              marginBottom: '16px',
            }}
          >
            <div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#0F172A' }}>
                Saved Templates
              </div>
              <div style={{ fontSize: '12.5px', color: '#64748B', marginTop: '3px' }}>
                Manage your saved email templates
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative' }}>
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    fontSize: '12px',
                    color: '#94A3B8',
                    pointerEvents: 'none',
                  }}
                >
                  🔍
                </span>
                <input
                  type="text"
                  value={savedSearch}
                  onChange={(e) => setSavedSearch(e.target.value)}
                  placeholder="Search templates..."
                  style={{
                    padding: '8px 12px 8px 30px',
                    borderRadius: '9px',
                    border: '1px solid #E2E8F0',
                    background: '#FFFFFF',
                    fontSize: '12.5px',
                    color: '#334155',
                    width: '210px',
                    outline: 'none',
                  }}
                />
              </div>
              <button
                type="button"
                style={toolButton}
                onClick={() => void loadTemplates()}
                disabled={templatesLoading}
                title="Refresh the saved templates list"
              >
                ↻ Refresh
              </button>
            </div>
          </div>

          {templatesError ? (
            <div
              style={{
                padding: '28px 16px',
                borderRadius: '12px',
                background: '#FEF2F2',
                border: '1px solid #FECACA',
                color: '#B91C1C',
                fontSize: '13px',
                textAlign: 'center',
              }}
            >
              Unable to load templates.
              <div style={{ marginTop: '10px' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void loadTemplates()}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : templatesLoading ? (
            <SavedTemplatesSkeleton />
          ) : savedTemplatesFiltered.length === 0 ? (
            <div
              style={{
                padding: '40px 16px',
                borderRadius: '12px',
                background: '#F8FAFC',
                border: '1px dashed #CBD5E1',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#334155' }}>
                No saved templates yet
              </div>
              <div style={{ fontSize: '12.5px', color: '#64748B', marginTop: '6px' }}>
                Create your first email template using the editor above.
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {savedVisible.map((t) => {
                  const thumb = thumbnailHtml[t.id];
                  const isEditing = selectedTemplate?.id === t.id;
                  return (
                    <div
                      key={t.id}
                      style={{
                        display: 'flex',
                        alignItems: 'stretch',
                        gap: '16px',
                        padding: '14px',
                        border: isEditing ? '1.5px solid #2563EB' : '1px solid #E5E7EB',
                        borderRadius: '12px',
                        background: isEditing ? '#EFF6FF' : '#FFFFFF',
                        transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
                        boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
                      }}
                      onMouseEnter={(e) => {
                        if (!isEditing)
                          e.currentTarget.style.boxShadow = '0 4px 14px rgba(15,23,42,0.10)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.boxShadow = '0 1px 2px rgba(15,23,42,0.04)';
                      }}
                    >
                      {/* LEFT — actual saved HTML thumbnail */}
                      <div style={{ width: '150px', flexShrink: 0 }}>
                        {thumb === undefined ? (
                          <div
                            style={{
                              height: 120,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              border: '1px solid #E2E8F0',
                              borderRadius: '8px',
                              background: '#F8FAFC',
                              color: '#94A3B8',
                              fontSize: '11px',
                            }}
                          >
                            Loading preview…
                          </div>
                        ) : thumb ? (
                          <TemplateThumb html={thumb} height={120} />
                        ) : (
                          <div
                            style={{
                              height: 120,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              border: '1px solid #E2E8F0',
                              borderRadius: '8px',
                              background: '#F8FAFC',
                              color: '#94A3B8',
                              fontSize: '11px',
                              padding: '8px',
                              textAlign: 'center',
                            }}
                          >
                            No preview available
                          </div>
                        )}
                      </div>

                      {/* MIDDLE — name, date, type label */}
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'center',
                        }}
                      >
                        <div
                          style={{
                            fontSize: '14.5px',
                            fontWeight: 700,
                            color: '#0F172A',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={t.name}
                        >
                          {t.name || 'Untitled Template'}
                        </div>
                        <div style={{ fontSize: '11.5px', color: '#64748B', marginTop: '4px' }}>
                          {t.updated_at || t.created_at
                            ? `Updated: ${formatCreatedDate(t.updated_at || t.created_at)}`
                            : 'Not yet saved'}
                        </div>
                        {t.category ? (
                          <div style={{ marginTop: '7px' }}>
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '2px 8px',
                                borderRadius: '999px',
                                background: '#F1F5F9',
                                border: '1px solid #E2E8F0',
                                fontSize: '10.5px',
                                fontWeight: 600,
                                color: '#475569',
                                textTransform: 'capitalize',
                              }}
                            >
                              {t.category}
                            </span>
                          </div>
                        ) : null}
                      </div>

                      {/* RIGHT — actions */}
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-end',
                          justifyContent: 'center',
                          gap: '8px',
                          flexShrink: 0,
                        }}
                      >
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            type="button"
                            style={{
                              ...toolButton,
                              padding: '6px 12px',
                              color: '#1D4ED8',
                              borderColor: '#BFDBFE',
                              background: '#EFF6FF',
                            }}
                            onClick={() => editSavedTemplate(t)}
                            title="Open this template in the editor"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            style={{ ...toolButton, padding: '6px 12px' }}
                            onClick={() => void openPreviewForTemplate(t)}
                            title="Preview this template"
                          >
                            Preview
                          </button>
                        </div>
                        <button
                          type="button"
                          style={{
                            ...toolButton,
                            padding: '6px 12px',
                            color: '#B91C1C',
                            borderColor: '#FECACA',
                            background: '#FEF2F2',
                          }}
                          onClick={() => setDeleteTarget(t)}
                          title="Delete this template"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {!showAllSaved && !searching && savedTemplatesFiltered.length > INITIAL_SAVED_COUNT && (
                <div style={{ marginTop: '14px', textAlign: 'center' }}>
                  <button
                    type="button"
                    style={{
                      ...toolButton,
                      color: '#1D4ED8',
                      borderColor: '#BFDBFE',
                      background: '#EFF6FF',
                    }}
                    onClick={() => setShowAllSaved(true)}
                  >
                    View All Templates ({savedTemplatesFiltered.length})
                  </button>
                </div>
              )}

              {showAllSaved && !searching && savedTemplatesFiltered.length > INITIAL_SAVED_COUNT && (
                <div style={{ marginTop: '14px', textAlign: 'center' }}>
                  <button
                    type="button"
                    style={{ ...toolButton }}
                    onClick={() => setShowAllSaved(false)}
                  >
                    Show Less
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ─── Template library / selector modal ─── */}
      {libraryOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '740px' }}>
            <div className="modal-header">
              <div className="modal-title">Select Template</div>
              <button className="btn-icon" onClick={() => setLibraryOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              {templatesLoading ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <span className="seqb-spin">⟳</span>
                  </div>
                  <div className="empty-title">Loading templates…</div>
                </div>
              ) : templatesError ? (
                <div className="empty-state">
                  <div className="empty-icon">⚠</div>
                  <div className="empty-title">Could not load templates</div>
                  <div className="empty-sub">{templatesError}</div>
                </div>
              ) : templates.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">✉</div>
                  <div className="empty-title">No templates available</div>
                  <div className="empty-sub">
                    Upload an HTML template or create a new one to get started.
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(205px, 1fr))',
                    gap: '14px',
                  }}
                >
                  {templates.map((t) => {
                    const thumb = thumbnailHtml[t.id];
                    const isSelected = selectedTemplate?.id === t.id;
                    const isLoading = templateLoadingId === t.id;
                    return (
                      <div
                        key={t.id}
                        onClick={() => {
                          setLibraryOpen(false);
                          handleSelectTemplate(t);
                        }}
                        title="Open in the visual editor"
                        style={{
                          border: isSelected ? '2px solid #2563EB' : '1px solid #E2E8F0',
                          borderRadius: '12px',
                          background: isSelected ? '#EFF6FF' : '#FFFFFF',
                          padding: '10px',
                          cursor: isLoading ? 'wait' : 'pointer',
                          boxSizing: 'border-box',
                          opacity: isLoading ? 0.6 : 1,
                        }}
                      >
                        {thumb === undefined ? (
                          <div
                            style={{
                              height: 132,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              border: '1px solid #E2E8F0',
                              borderRadius: '8px',
                              background: '#F8FAFC',
                              color: '#94A3B8',
                              fontSize: '11.5px',
                            }}
                          >
                            Loading preview…
                          </div>
                        ) : thumb ? (
                          <TemplateThumb html={thumb} />
                        ) : (
                          <div
                            style={{
                              height: 132,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              border: '1px solid #E2E8F0',
                              borderRadius: '8px',
                              background: '#F8FAFC',
                              color: '#94A3B8',
                              fontSize: '11.5px',
                            }}
                          >
                            No preview
                          </div>
                        )}
                        <div
                          style={{
                            fontSize: '12.5px',
                            fontWeight: 700,
                            color: isSelected ? '#1D4ED8' : '#1E293B',
                            marginTop: '8px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {t.name}
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginTop: '3px',
                          }}
                        >
                          <span style={{ fontSize: '10.5px', color: '#94A3B8' }}>
                            {formatCreatedDate(t.created_at) || t.category || 'Template'}
                          </span>
                          <span
                            style={{
                              fontSize: '10.5px',
                              fontWeight: 700,
                              color: '#2563EB',
                              textTransform: 'uppercase',
                              letterSpacing: '0.03em',
                            }}
                          >
                            Open →
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setLibraryOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Preview modal (Desktop / Mobile) ─── */}
      {previewOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: previewDevice === 'mobile' ? '520px' : '780px' }}>
            <div className="modal-header">
              <div className="modal-title">Email Preview</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={tabBtn(previewDevice === 'desktop')}
                  onClick={() => setPreviewDevice('desktop')}
                >
                  Desktop
                </button>
                <button
                  type="button"
                  style={tabBtn(previewDevice === 'mobile')}
                  onClick={() => setPreviewDevice('mobile')}
                >
                  Mobile
                </button>
                <span style={{ width: 1, height: 20, background: '#E2E8F0', margin: '0 6px' }} />
                <button className="btn-icon" onClick={() => setPreviewOpen(false)}>
                  ✕
                </button>
              </div>
            </div>
            <div
              className="modal-body"
              style={{
                background: '#E2E8F0',
                display: 'flex',
                justifyContent: 'center',
                padding: previewDevice === 'mobile' ? '18px' : '26px',
              }}
            >
              <iframe
                title="email preview"
                sandbox=""
                srcDoc={displayPreviewHtml}
                style={{
                  width: previewDevice === 'mobile' ? '375px' : '640px',
                  height: '660px',
                  border: 'none',
                  background: '#FFFFFF',
                  borderRadius: previewDevice === 'mobile' ? '20px' : '6px',
                  boxShadow: '0 8px 24px rgba(15,23,42,0.2)',
                }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setPreviewOpen(false)}>
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Save As / New template name modal ─── */}
      {saveAsOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '440px' }}>
            <div className="modal-header">
              <div className="modal-title">
                {saveAsMode === 'new' ? 'Save New Template' : 'Save Template As'}
              </div>
              <button className="btn-icon" onClick={() => setSaveAsOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Template Name</label>
                <input
                  type="text"
                  value={saveAsName}
                  onChange={(e) => setSaveAsName(e.target.value)}
                  placeholder="Enter a name for this template"
                  autoFocus
                />
              </div>
              <div style={{ fontSize: '11.5px', color: '#64748B', lineHeight: 1.5 }}>
                {saveAsMode === 'new'
                  ? 'This creates a new template in the templates library. It will be available in the Campaign Composer and Template Library immediately.'
                  : 'This saves a copy as a new template. The current template remains unchanged.'}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSaveAsOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void confirmSaveAs()}
                disabled={savingAs}
              >
                {savingAs ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Discard-unsaved-changes confirmation ─── */}
      {unsavedAction && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '440px' }}>
            <div className="modal-header">
              <div className="modal-title">Discard unsaved changes?</div>
              <button className="btn-icon" onClick={() => setUnsavedAction(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body" style={{ fontSize: '13px', color: '#475569' }}>
              You have unsaved changes in the current template. They will be lost if you continue.
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setUnsavedAction(null)}>
                Keep editing
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  unsavedAction();
                  setUnsavedAction(null);
                }}
              >
                Discard &amp; continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Delete saved-template confirmation ─── */}
      {deleteTarget && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '440px' }}>
            <div className="modal-header">
              <div className="modal-title">Delete this template?</div>
              <button className="btn-icon" onClick={() => setDeleteTarget(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body" style={{ fontSize: '13px', color: '#475569' }}>
              Are you sure you want to permanently delete this template?
              {deleteTarget.name ? (
                <div style={{ marginTop: '10px', fontWeight: 600, color: '#1E293B' }}>
                  “{deleteTarget.name}”
                </div>
              ) : null}
            </div>
            <div className="modal-footer">
              <button
                className="btn"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => void confirmDeleteSaved()}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
