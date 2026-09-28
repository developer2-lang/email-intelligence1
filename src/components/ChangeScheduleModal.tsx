import { useMemo, useState } from 'react';
import { formatManualScheduledTime } from '../utils/cronUtils';
import {
  BATCH_DELAY_OPTIONS,
  SCHEDULE_TIMEZONE_LABEL,
  SCHEDULE_TYPES,
  WEEKDAY_NAMES,
  buildSchedulePreview,
  defaultScheduleForm,
  type ScheduleBatch,
  type ScheduleFormState,
  type ScheduleType,
  type WeekdayName,
} from '../utils/weeklyQueueSchedule';

/**
 * ChangeScheduleModal
 *
 * Reschedules a set of PENDING weekly-queue rows to a new date/time, using the
 * same controls, labels and batch-preview wording as the existing campaign
 * schedule section (src/pages/CampaignsTab.tsx — "Schedule Settings" and
 * "Sending Limits").
 *
 * What it deliberately does NOT do:
 *   • send anything. It returns a batch plan; the caller persists it.
 *   • touch any non-pending row. Selection is the caller's job; this component
 *     only ever receives rows that are still 'pending'.
 *   • create or delete queue rows.
 *
 * The batch plan is produced by the pure helper in utils/weeklyQueueSchedule, so
 * what the preview shows is exactly what the caller writes to `scheduled_for`.
 */

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export interface ChangeScheduleModalProps {
  /** The selected PENDING queue rows. Never includes sent/sending/failed/skipped. */
  rows: { id: string; status: string; queued_at: string | null }[];
  submitting: boolean;
  onClose: () => void;
  /**
   * Receives the plan to persist. The caller performs the UPDATE and decides
   * what success/failure means — this component never touches the database.
   */
  onSubmit: (plan: { batches: ScheduleBatch[]; scheduleType: ScheduleType }) => void;
}

// ─── Shared style tokens, matched to the campaign schedule section ──────────
const INPUT_STYLE = {
  width: '100%',
  height: '48px',
  padding: '0 16px',
  border: '1px solid #E2E8F0',
  borderRadius: '10px',
  fontSize: '13px',
  outline: 'none',
  background: '#FFFFFF',
  color: '#334155',
  boxSizing: 'border-box',
} as const;

const LABEL_STYLE = {
  fontSize: '14px',
  fontWeight: 600,
  color: '#334155',
  display: 'block',
  marginBottom: '6px',
} as const;

const SECTION_TITLE_STYLE = {
  fontSize: '12px',
  letterSpacing: '0.05em',
  color: '#8A94A6',
  fontWeight: 700,
  textTransform: 'uppercase',
} as const;

const RADIO_STYLE = {
  accentColor: '#2563EB',
  width: '16px',
  height: '16px',
  cursor: 'pointer',
  margin: 0,
} as const;

const CHECKBOX_STYLE = { ...RADIO_STYLE, width: '18px', height: '18px' } as const;

const SMALL_INPUT_STYLE = {
  width: '100%',
  height: '40px',
  padding: '0 12px',
  border: '1px solid #E2E8F0',
  borderRadius: '8px',
  fontSize: '13px',
  outline: 'none',
  background: '#FFFFFF',
  color: '#334155',
  boxSizing: 'border-box',
} as const;

export default function ChangeScheduleModal({
  rows,
  submitting,
  onClose,
  onSubmit,
}: ChangeScheduleModalProps) {
  // Both initialisers are lazy, so the form (and the "now" used to resolve
  // relative dates like "this Thursday") are frozen at mount. The parent mounts
  // this component fresh each time the dialog opens, so no reset effect is
  // needed — remounting *is* the reset.
  const [form, setForm] = useState<ScheduleFormState>(() => defaultScheduleForm());
  const [openedAt] = useState(() => new Date());

  // Re-derive the whole plan on every keystroke. Cheap: pure in-memory maths
  // over at most a few thousand ids.
  const plan = useMemo(
    () => buildSchedulePreview(rows, form, openedAt),
    [rows, form, openedAt]
  );

  const totalContacts = plan.totalContacts;
  const canSubmit = totalContacts > 0 && plan.error === null && plan.batches.length > 0 && !submitting;

  const set = <K extends keyof ScheduleFormState>(key: K, value: ScheduleFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Keep the monthly day-of-month in step with whichever month the date field
  // currently points at, unless the user has explicitly edited the spinner.
  const onDateChange = (value: string) => {
    setForm((prev) => {
      const day = Number(value.slice(8, 10));
      return {
        ...prev,
        date: value,
        dayOfMonth: Number.isFinite(day) && day >= 1 && day <= 31 ? day : prev.dayOfMonth,
      };
    });
  };

  return (
    <div className="modal-overlay">
      <div className="modal modal-wide" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <div>
            <div className="modal-title">Change Schedule</div>
            <div className="ct-sub" style={{ marginTop: 3 }}>
              {totalContacts} pending contact{totalContacts === 1 ? '' : 's'} selected
            </div>
          </div>
          <button className="modal-close" onClick={onClose} title="Close" disabled={submitting}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Reminder of what stays automatic — the key invariant of this feature. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '10px 12px',
              marginBottom: 16,
              borderRadius: 8,
              background: '#EFF6FF',
              border: '1px solid #BFDBFE',
              color: '#1E40AF',
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            Only the {totalContacts} selected pending contact
            {totalContacts === 1 ? '' : 's'} will move to this schedule. Every other pending record
            keeps the automatic Thursday 7:30 AM IST slot, and this action only changes the stored
            schedule — the existing weekly queue processor still sends the emails.
          </div>

          {/* ─── SCHEDULE SETTINGS ─── */}
          <div style={{ height: '1px', background: '#E5E7EB', margin: '0 0 12px' }} />
          <div style={{ ...SECTION_TITLE_STYLE, marginBottom: '12px' }}>Schedule Settings</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <div style={LABEL_STYLE}>Schedule Type</div>
              <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                {SCHEDULE_TYPES.map(({ key, label }) => (
                  <label
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '13px',
                      color: '#334155',
                      cursor: 'pointer',
                      fontWeight: 500,
                    }}
                  >
                    <input
                      type="radio"
                      name="wqScheduleType"
                      checked={form.scheduleType === key}
                      onChange={() => set('scheduleType', key)}
                      style={RADIO_STYLE}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {form.scheduleType === 'one_time' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: '12px' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={LABEL_STYLE}>Schedule Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={(e) => onDateChange(e.target.value)}
                    style={INPUT_STYLE}
                  />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={LABEL_STYLE}>Time ({SCHEDULE_TIMEZONE_LABEL})</label>
                  <input
                    type="text"
                    value={form.time}
                    onChange={(e) => set('time', e.target.value)}
                    placeholder="10:00 AM"
                    style={INPUT_STYLE}
                  />
                </div>
              </div>
            )}

            {form.scheduleType === 'weekly' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <div style={LABEL_STYLE}>Send On</div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
                      gap: '8px',
                    }}
                  >
                    {WEEKDAY_NAMES.map((day: WeekdayName) => (
                      <label
                        key={day}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          fontSize: '13px',
                          color: '#334155',
                          cursor: 'pointer',
                          fontWeight: 500,
                        }}
                      >
                        <input
                          type="radio"
                          name="wqWeekday"
                          checked={form.weekday === day}
                          onChange={() => set('weekday', day)}
                          style={RADIO_STYLE}
                        />
                        {day}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={LABEL_STYLE}>Time ({SCHEDULE_TIMEZONE_LABEL})</label>
                  <input
                    type="text"
                    value={form.time}
                    onChange={(e) => set('time', e.target.value)}
                    placeholder="10:00 AM"
                    style={{ ...INPUT_STYLE, width: '160px' }}
                  />
                </div>
                <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.5 }}>
                  The first occurrence after now is used, inside the existing weekly send window
                  (7:30 AM – 11:30 PM IST). Each contact is emailed once, exactly as with the
                  automatic Thursday run.
                </div>
              </div>
            )}

            {form.scheduleType === 'monthly' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <div style={LABEL_STYLE}>Monthly Schedule</div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      fontSize: '13px',
                      color: '#334155',
                      cursor: 'pointer',
                      fontWeight: 500,
                    }}
                  >
                    <input
                      type="radio"
                      name="wqMonthlyOption"
                      checked
                      readOnly
                      style={RADIO_STYLE}
                    />
                    Day of Month
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={form.dayOfMonth}
                      onChange={(e) =>
                        set('dayOfMonth', Math.min(31, Math.max(1, Number(e.target.value) || 1)))
                      }
                      style={{
                        width: '64px',
                        height: '40px',
                        padding: '0 8px',
                        border: '1px solid #E2E8F0',
                        borderRadius: '10px',
                        fontSize: '13px',
                        outline: 'none',
                        textAlign: 'center',
                        background: '#FFFFFF',
                        color: '#334155',
                      }}
                    />
                    <span style={{ color: '#64748B' }}>
                      of the month selected below
                      {form.date ? ` (${form.date})` : ''}
                    </span>
                  </label>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: '12px' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={LABEL_STYLE}>Starting Month</label>
                    <input
                      type="date"
                      value={form.date}
                      onChange={(e) => onDateChange(e.target.value)}
                      style={INPUT_STYLE}
                    />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label style={LABEL_STYLE}>Time ({SCHEDULE_TIMEZONE_LABEL})</label>
                    <input
                      type="text"
                      value={form.time}
                      onChange={(e) => set('time', e.target.value)}
                      placeholder="10:00 AM"
                      style={INPUT_STYLE}
                    />
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.5 }}>
                  The first occurrence on or after the selected month is used. Day 31 falls back to
                  the last day of shorter months.
                </div>
              </div>
            )}
          </div>

          {/* ─── SENDING LIMITS / BATCH SENDING ─── */}
          <div style={{ height: '1px', background: '#E5E7EB', margin: '16px 0 12px' }} />
          <div style={{ ...SECTION_TITLE_STYLE, marginBottom: '12px' }}>Sending Limits</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                fontSize: '13px',
                color: '#334155',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              <input
                type="checkbox"
                checked={form.sendInBatches}
                onChange={(e) => set('sendInBatches', e.target.checked)}
                style={CHECKBOX_STYLE}
              />
              Send in batches
            </label>

            {form.sendInBatches && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  padding: '16px',
                  background: '#F8FAFC',
                  border: '1px solid #E2E8F0',
                  borderRadius: '10px',
                }}
              >
                <div style={{ display: 'flex', gap: '24px' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: '#64748B',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Batch Size
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        value={form.batchSize}
                        onChange={(e) => set('batchSize', Math.max(1, parseInt(e.target.value) || 1))}
                        min={1}
                        max={1000}
                        style={{ ...SMALL_INPUT_STYLE, width: '100px', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: '13px', color: '#64748B' }}>contacts</span>
                    </div>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: '#64748B',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Send next batch after
                    </label>
                    <select
                      value={form.batchDelayHours}
                      onChange={(e) => set('batchDelayHours', parseFloat(e.target.value))}
                      style={{ ...SMALL_INPUT_STYLE, cursor: 'pointer' }}
                    >
                      {BATCH_DELAY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* ─── BATCH PREVIEW (same wording as the campaigns preview) ─── */}
                {totalContacts === 0 ? (
                  <div style={{ fontSize: '13px', color: '#64748B' }}>No pending contacts selected.</div>
                ) : plan.error ? (
                  <div style={{ fontSize: '13px', color: '#B91C1C', fontWeight: 500 }}>{plan.error}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '13px', color: '#1D4ED8', fontWeight: 500 }}>
                      {plan.cadenceLine}
                    </div>
                    <div style={{ fontSize: '12px', color: '#475569' }}>
                      Selected contacts: {plan.totalContacts}
                    </div>
                    <div style={{ fontSize: '12px', color: '#475569' }}>
                      Batch size: {plan.batchSize}
                    </div>
                    <div style={{ fontSize: '12px', color: '#475569', fontWeight: 500 }}>
                      Estimated batches: {plan.estimatedBatches}
                    </div>

                    <div
                      style={{
                        maxHeight: '200px',
                        overflowY: 'auto',
                        fontSize: '12px',
                        color: '#334155',
                        background: '#FFFFFF',
                        border: '1px solid #E2E8F0',
                        borderRadius: '8px',
                        padding: '12px',
                      }}
                    >
                      {plan.batches.map((batch) => (
                        <div
                          key={batch.batchNumber}
                          style={{
                            padding: '4px 0',
                            borderBottom:
                              batch.batchNumber < plan.batches.length ? '1px solid #F1F5F9' : 'none',
                          }}
                        >
                          Batch {batch.batchNumber}: S.No. {batch.fromSno}–{batch.toSno}
                          <span style={{ color: '#64748B' }}>
                            {' '}
                            · {formatManualScheduledTime(batch.scheduledFor)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {!form.sendInBatches && totalContacts > 0 && !plan.error && plan.batches[0] && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '12px',
                  background: '#F8FAFC',
                  border: '1px solid #E2E8F0',
                  borderRadius: '10px',
                  fontSize: '12px',
                  color: '#475569',
                }}
              >
                <div style={{ fontSize: '13px', color: '#1D4ED8', fontWeight: 500 }}>
                  {plan.cadenceLine}
                </div>
                <div>
                  Batch 1: S.No. 1–{plan.totalContacts} ·{' '}
                  {formatManualScheduledTime(plan.batches[0].scheduledFor)}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => onSubmit({ batches: plan.batches, scheduleType: form.scheduleType })}
          >
            {submitting ? 'Saving...' : 'Change Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
