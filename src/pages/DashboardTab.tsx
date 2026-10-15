import { useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { AV_COLORS } from '../constants/constants'
import { drawPerformanceChart } from '../utils/charts'
import type { ActivityItem, ActivityType, EngagedContact } from '../services/dashboardService'

type DashboardTabKey =
  | 'dashboard'
  | 'contacts'
  | 'campaigns'
  | 'sequences'

interface DashboardTabProps {
  contacts: any[]
  campaigns: any[]
  activeSequencesCount: number
  enrolledContactsCount?: number
  activityFeed?: ActivityItem[]
  topEngaged?: EngagedContact[]
  chart1Ref: RefObject<HTMLCanvasElement | null>
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onNavigate: (tab: DashboardTabKey) => void
}

const CARD_TONES = {
  blue: { iconBg: '#EFF6FF', iconFg: '#2563EB' },
  green: { iconBg: '#ECFDF5', iconFg: '#059669' },
  amber: { iconBg: '#FFFBEB', iconFg: '#D97706' },
  violet: { iconBg: '#F5F3FF', iconFg: '#7C3AED' },
} as const

const ACTIVITY_TONES: Record<ActivityType, { bg: string; fg: string }> = {
  sent: { bg: '#EFF6FF', fg: '#2563EB' },
  opened: { bg: '#ECFDF5', fg: '#059669' },
  clicked: { bg: '#F5F3FF', fg: '#7C3AED' },
  enrolled: { bg: '#FFFBEB', fg: '#D97706' },
  seq: { bg: '#F0F9FF', fg: '#0369A1' },
}

const ACTIVITY_ICONS: Record<ActivityType, string> = {
  sent: '✉',
  opened: '👁',
  clicked: '↗',
  enrolled: '⟳',
  seq: '⚡',
}

function initials(name?: string): string {
  if (!name) return ''
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function DashCard({
  label,
  value,
  icon,
  tone,
  sub,
}: {
  label: string
  value: string
  icon: string
  tone: keyof typeof CARD_TONES
  sub: string
}) {
  const t = CARD_TONES[tone]
  return (
    <div className="dash-card">
      <div className="dash-card-top">
        <div className="dash-card-icon" style={{ background: t.iconBg, color: t.iconFg }}>
          {icon}
        </div>
      </div>
      <div className="dash-card-value">{value}</div>
      <div className="dash-card-label">{label}</div>
      <div className="dash-card-sub">{sub}</div>
    </div>
  )
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const tone = ACTIVITY_TONES[item.type]
  const avatar = item.person ? initials(item.person) : ACTIVITY_ICONS[item.type]
  return (
    <div className="activity-row">
      <div className="activity-avatar" style={{ background: tone.bg, color: tone.fg }}>
        {avatar}
      </div>
      <div className="activity-body">
        <div className="activity-line">{item.title}</div>
        {item.company && <div className="activity-company">{item.company}</div>}
      </div>
      <div className="activity-time">{item.time}</div>
    </div>
  )
}

function EngagedRow({ contact, max }: { contact: EngagedContact; max: number }) {
  const color = AV_COLORS[(contact.name.charCodeAt(0) || 0) % AV_COLORS.length]
  const pct = max > 0 ? Math.max(6, Math.round((contact.score / max) * 100)) : 6
  return (
    <div className="activity-row">
      <div className="activity-avatar" style={{ background: color, color: '#fff' }}>
        {initials(contact.name)}
      </div>
      <div className="activity-body">
        <div className="activity-line" style={{ fontWeight: 700 }}>
          {contact.name}
        </div>
        <div className="activity-company">{contact.company || '—'}</div>
        <div className="progress" style={{ marginTop: 6 }}>
          <div className="progress-fill green" style={{ width: `${pct}%` }}></div>
        </div>
      </div>
      <div className="engaged-meta">
        <div className="engaged-count">
          {contact.opens}
          <span> opens</span>
        </div>
        <div className="activity-time">{contact.clicks} clicks</div>
      </div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="page active">
      <div style={{ marginBottom: '22px' }}>
        <div className="skeleton" style={{ width: 220, height: 22 }}></div>
        <div className="skeleton" style={{ width: 320, height: 12, marginTop: 10 }}></div>
      </div>
      <div className="dash-cards">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton sk-card"></div>
        ))}
      </div>
      <div className="dash-main-grid">
        <div className="skeleton sk-block"></div>
        <div className="skeleton sk-block"></div>
      </div>
      <div className="dash-grid-2">
        <div className="skeleton sk-block"></div>
        <div className="skeleton sk-block"></div>
      </div>
    </div>
  )
}

function DashboardError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="page active">
      <div className="dash-error">
        <div className="dash-error-icon">⚠️</div>
        <div className="dash-error-title">Couldn't load dashboard data</div>
        <div className="dash-error-sub">{message}</div>
        {onRetry && (
          <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  )
}

export default function DashboardTab({
  contacts,
  campaigns,
  activeSequencesCount,
  enrolledContactsCount = 0,
  activityFeed,
  topEngaged,
  chart1Ref,
  loading = false,
  error = null,
  onRetry,
  onNavigate,
}: DashboardTabProps) {
  const feed = activityFeed || []
  const engaged = topEngaged || []

  // All dashboard numbers are derived from the REAL data loaded from Supabase
  // (contacts, campaigns decorated with tracking metrics, sequences).
  const stats = useMemo(() => {
    const sentCampaigns = campaigns.filter(
      (c) => String(c.status).toLowerCase() === 'sent' && (c.deliveredCount || 0) > 0,
    )
    const sentCount = campaigns.filter((c) => String(c.status).toLowerCase() === 'sent').length
    const scheduledCount = campaigns.filter(
      (c) => String(c.status).toLowerCase() === 'scheduled',
    ).length
    const totalEmailsSent = sentCampaigns.reduce((sum, c) => sum + (c.deliveredCount || 0), 0)
    const avgOpenRate = sentCampaigns.length
      ? sentCampaigns.reduce((sum, c) => sum + (c.openRate || 0), 0) / sentCampaigns.length
      : 0
    const avgClickRate = sentCampaigns.length
      ? sentCampaigns.reduce((sum, c) => sum + (c.clickRate || 0), 0) / sentCampaigns.length
      : 0
    return { sentCampaigns, sentCount, scheduledCount, totalEmailsSent, avgOpenRate, avgClickRate }
  }, [campaigns])

  // Most recent 6 sent campaigns, oldest → newest left to right.
  const chartCampaigns = useMemo(
    () => stats.sentCampaigns.slice(0, 6).reverse(),
    [stats.sentCampaigns],
  )

  const uniqueCompanies = useMemo(
    () => new Set(contacts.map((c) => c.company).filter(Boolean)).size,
    [contacts],
  )

  const quickCampaigns = useMemo(
    () => campaigns.filter((c) => (c.deliveredCount || 0) > 0).slice(0, 4),
    [campaigns],
  )

  // Draw the real-data performance chart and keep it crisp on resize.
  useEffect(() => {
    if (loading) return
    const canvas = chart1Ref.current
    if (!canvas || chartCampaigns.length === 0) return
    const draw = () => drawPerformanceChart(canvas, chartCampaigns)
    draw()
    const parent = canvas.parentElement
    const ro =
      parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null
    if (ro && parent) ro.observe(parent)
    window.addEventListener('resize', draw)
    return () => {
      if (ro) ro.disconnect()
      window.removeEventListener('resize', draw)
    }
  }, [chart1Ref, chartCampaigns, loading])

  if (loading) return <DashboardSkeleton />
  if (error) return <DashboardError message={error} onRetry={onRetry} />

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  const contactsSub =
    contacts.length > 0
      ? `${uniqueCompanies} ${uniqueCompanies === 1 ? 'company' : 'companies'}`
      : 'No contacts yet'
  const openSub =
    stats.sentCampaigns.length > 0
      ? `${stats.avgClickRate.toFixed(1)}% avg click rate`
      : 'No click data yet'
  const seqSub =
    activeSequencesCount > 0
      ? enrolledContactsCount > 0
        ? `${enrolledContactsCount} ${enrolledContactsCount === 1 ? 'contact' : 'contacts'} enrolled`
        : 'No enrollments yet'
      : 'No active sequences yet'
  const emailsSub =
    stats.sentCount > 0
      ? `${stats.sentCount} ${stats.sentCount === 1 ? 'campaign' : 'campaigns'} sent`
      : stats.scheduledCount > 0
        ? `${stats.scheduledCount} scheduled`
        : 'No campaigns sent yet'

  const engagedMax = engaged.length > 0 ? Math.max(...engaged.map((c) => c.score), 1) : 1

  return (
    <div className="page active">
      <div className="dash-header">
        <div>
          <div className="dash-greeting">{greeting} 👋</div>
          <div className="dash-subtitle">Here's what's happening with your email outreach today.</div>
        </div>
      </div>

      <div className="dash-cards">
        <DashCard
          label="Total Contacts"
          value={contacts.length.toLocaleString()}
          icon="👥"
          tone="blue"
          sub={contactsSub}
        />
        <DashCard
          label="Average Open Rate"
          value={`${stats.avgOpenRate.toFixed(1)}%`}
          icon="👁"
          tone="green"
          sub={openSub}
        />
        <DashCard
          label="Active Sequences"
          value={String(activeSequencesCount)}
          icon="⟳"
          tone="amber"
          sub={seqSub}
        />
        <DashCard
          label="Emails Sent"
          value={stats.totalEmailsSent.toLocaleString()}
          icon="✉"
          tone="violet"
          sub={emailsSub}
        />
      </div>

      <div className="dash-main-grid">
        <div className="card dash-chart-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title">Campaign Performance</div>
              <div className="dash-card-subtitle">Opened vs clicked across recent sent campaigns</div>
            </div>
          </div>
          {chartCampaigns.length > 0 ? (
            <div className="dash-chart-body">
              <canvas ref={chart1Ref} id="dash-perf-chart"></canvas>
            </div>
          ) : (
            <div className="dash-empty">
              <div className="dash-empty-icon">📊</div>
              <div className="dash-empty-title">No campaign performance data yet</div>
              <div className="dash-empty-sub">
                Send a campaign to see open and click performance here.
              </div>
            </div>
          )}
        </div>

        <div className="card dash-activity-card">
          <div className="dash-card-head">
            <div className="dash-card-title">Recent Activity</div>
          </div>
          {feed.length > 0 ? (
            <div className="dash-activity">
              {feed.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <div className="dash-empty">
              <div className="dash-empty-icon">🔔</div>
              <div className="dash-empty-title">No recent activity</div>
              <div className="dash-empty-sub">There is no recent activity to display.</div>
            </div>
          )}
          <div className="dash-card-foot">
            <button className="btn btn-ghost btn-xs" onClick={() => onNavigate('contacts')}>
              View all activity →
            </button>
          </div>
        </div>
      </div>

      <div className="dash-grid-2">
        <div className="card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title">Top Engaged Contacts</div>
              <div className="dash-card-subtitle">Most active recipients by opens and clicks</div>
            </div>
          </div>
          {engaged.length > 0 ? (
            <div className="dash-activity">
              {engaged.map((c) => (
                <EngagedRow key={c.id} contact={c} max={engagedMax} />
              ))}
            </div>
          ) : (
            <div className="dash-empty">
              <div className="dash-empty-icon">⭐</div>
              <div className="dash-empty-title">No engagement data yet</div>
              <div className="dash-empty-sub">
                Opens and clicks will show up here as recipients engage.
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title">Campaign Quick Stats</div>
              <div className="dash-card-subtitle">Open and click rates by campaign</div>
            </div>
          </div>
          {quickCampaigns.length > 0 ? (
            <div className="dash-activity">
              {quickCampaigns.map((c) => (
                <div key={c.id} className="quick-row">
                  <div className="quick-main">
                    <div className="activity-line" style={{ fontWeight: 700 }}>
                      {c.name}
                    </div>
                    <div className="activity-company">
                      {c.date !== '—' ? c.date : '—'} · {c.deliveredCount} sent
                    </div>
                  </div>
                  <div className="quick-rate">
                    <div className="quick-open">{(c.openRate || 0).toFixed(1)}%</div>
                    <div className="activity-time">open · {(c.clickRate || 0).toFixed(1)}% click</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="dash-empty">
              <div className="dash-empty-icon">✉</div>
              <div className="dash-empty-title">No campaigns with delivery data yet</div>
              <div className="dash-empty-sub">Sent campaigns with tracking will appear here.</div>
            </div>
          )}
          <div className="dash-card-foot">
            <button className="btn btn-ghost btn-xs" onClick={() => onNavigate('campaigns')}>
              View all campaigns →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}