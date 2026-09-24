import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface SearchableOption {
  value: string
  label: string
}

interface SearchableSelectProps {
  label?: string
  options: SearchableOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  customOptions?: string[]
  onAddCustom?: (value: string) => void
  onRemoveCustom?: (value: string) => void
}

interface PanelPosition {
  top: number
  left: number
  width: number
}

export default function SearchableSelect({
  label,
  options,
  value,
  onChange,
  placeholder = 'Select...',
  customOptions,
  onAddCustom,
  onRemoveCustom,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hovered, setHovered] = useState<string | null>(null)
  const [isAddingCustom, setIsAddingCustom] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const [panelPos, setPanelPos] = useState<PanelPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Position the panel at the trigger, and keep it anchored while the page or
  // any scroll container moves. The panel is portaled to document.body so it
  // is never clipped by ancestor overflow containers (e.g. the scrollable
  // table wrapper in LeadDatabase) regardless of the selected value.
  useEffect(() => {
    if (!open) return
    const measure = () => {
      const el = triggerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setPanelPos({ top: r.bottom + 4, left: r.left, width: r.width })
    }
    let raf = requestAnimationFrame(measure)
    const onScrollOrResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node
      const insideRoot = rootRef.current?.contains(target) ?? false
      const insidePanel = panelRef.current?.contains(target) ?? false
      if (insideRoot || insidePanel) return
      setOpen(false)
      setQuery('')
      setHovered(null)
      setIsAddingCustom(false)
      setCustomValue('')
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [open])

  const selected = options.find((o) => o.value === value)
  const triggerText = selected?.label ?? value ?? placeholder

  const rows = useMemo(() => {
    const seen = new Set<string>()
    const items: { label: string; value: string; custom: boolean }[] = [
      { label: placeholder, value: '', custom: false },
      ...options.map((o) => ({ label: o.label, value: o.value, custom: false })),
      ...(customOptions ?? []).map((o) => ({ label: o, value: o, custom: true })),
    ]
    return items.filter((r) => {
      const key = r.label.trim().toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [placeholder, options, customOptions])

  const q = query.trim().toLowerCase()
  const filtered = rows.filter((r) => !q || r.label.trim().toLowerCase().includes(q))

  const choose = (val: string) => {
    onChange(val)
    setOpen(false)
    setQuery('')
    setHovered(null)
    setIsAddingCustom(false)
    setCustomValue('')
  }

  const submitCustom = () => {
    if (!onAddCustom) return
    const v = customValue.trim()
    if (!v) return
    onAddCustom(v)
    choose(v)
  }

  const cancelCustom = () => {
    setIsAddingCustom(false)
    setCustomValue('')
  }

  const close = () => {
    setOpen(false)
    setQuery('')
    setHovered(null)
    setIsAddingCustom(false)
    setCustomValue('')
  }

  return (
    <div className="ss-root" ref={rootRef}>
      {label && <label className="ss-label">{label}</label>}
      <button
        ref={triggerRef}
        type="button"
        className="ss-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`ss-trigger-text${value && value !== '' ? ' ss-has-value' : ''}`}>
          {triggerText}
        </span>
        <span className="ss-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open &&
        panelPos &&
        createPortal(
          <div
            className="ss-panel"
            ref={panelRef}
            style={{
              position: 'fixed',
              top: panelPos.top,
              left: panelPos.left,
              right: 'auto',
              width: panelPos.width,
              margin: 0,
              zIndex: 1000,
            }}
            role={isAddingCustom ? undefined : 'listbox'}
          >
            {isAddingCustom ? (
              <div className="ss-custom-panel">
                <div className="ss-custom-title">Add Custom {label || 'Option'}</div>
                <div className="ss-custom-label">Enter {label?.toLowerCase() || 'value'}</div>
                <input
                  type="text"
                  className="ss-custom-input"
                  value={customValue}
                  autoFocus
                  autoComplete="off"
                  placeholder={`Type ${label?.toLowerCase() || 'a value'}...`}
                  onChange={(e) => setCustomValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelCustom()
                    } else if (e.key === 'Enter') {
                      e.preventDefault()
                      submitCustom()
                    }
                  }}
                />
                <div className="ss-custom-actions">
                  <button type="button" className="ss-custom-cancel" onClick={cancelCustom}>
                    Cancel
                  </button>
                  <button type="button" className="ss-custom-submit" onClick={submitCustom}>
                    Add
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="ss-search">
                  <svg
                    className="ss-search-ic"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    width="13"
                    height="13"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={query}
                    autoFocus
                    autoComplete="off"
                    placeholder="Type to search..."
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        close()
                      } else if (e.key === 'Enter') {
                        e.preventDefault()
                        const [first] = filtered
                        if (first) {
                          choose(first.value)
                        }
                      }
                    }}
                  />
                </div>

                {onAddCustom && (
                  <div className="ss-add-row">
                    <button
                      type="button"
                      className="ss-add"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setCustomValue('')
                        setIsAddingCustom(true)
                      }}
                    >
                      + Add Custom {label || 'Option'}
                    </button>
                  </div>
                )}

                <div className="ss-list">
                  {filtered.length > 0 ? (
                    filtered.map((r) => {
                      const active = hovered === r.label || r.value === value
                      return (
                        <div
                          key={r.label}
                          role="option"
                          aria-selected={r.value === value}
                          className={`ss-option${active ? ' ss-option-active' : ''}`}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            if (!r.custom) choose(r.value)
                          }}
                          onMouseEnter={() => setHovered(r.label)}
                          onMouseLeave={() => setHovered((h) => (h === r.label ? null : h))}
                        >
                          <span className="ss-option-label">{r.label}</span>
                          {r.custom && onRemoveCustom && (
                            <span
                              title={`Remove ${r.label}`}
                              className="ss-option-remove"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation()
                                onRemoveCustom(r.label)
                                setHovered(null)
                              }}
                            >
                              ×
                            </span>
                          )}
                        </div>
                      )
                    })
                  ) : (
                    <div className="ss-empty">No matches</div>
                  )}
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}