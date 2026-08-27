/**
 * Backend API client for the campaign workflow.
 *
 * The backend (Express) owns the full send/schedule pipeline:
 * save to Supabase → fetch audience → sync Mailchimp → create campaign →
 * upload content → send/schedule → update Supabase.
 */
const rawApiUrl: string =
  (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:5000';

// The request helpers below already prefix every route with `/api`
// (e.g. `/api/campaigns`). Strip a trailing `/api` from the configured base so
// we don't end up with a doubled prefix like `/api/api/campaigns`. This lets
// `VITE_API_URL=/api` resolve to same-origin `/api/...` requests that are then
// forwarded by the Vercel rewrite to the backend.
const API_URL: string = rawApiUrl.replace(/\/api\/?$/, '');

import type {
  FollowupConfig,
  FollowupConfigApiResult,
  FollowupConfigRow,
  FollowupMode,
  OpenedContact,
  PendingFollowup,
} from '../types/campaign';

interface ApiResponse<T> {
  success?: boolean;
  message?: string;
  data?: T;
  error?: { status?: number; message?: string; detail?: string };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Cannot reach the backend at ${API_URL}. Is it running?`);
  }

  const json: ApiResponse<T> = await res.json().catch(() => ({}));

  if (!res.ok || json.success === false) {
    const message =
      json?.error?.message ||
      json?.error?.detail ||
      json?.message ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }

  return json.data as T;
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`);
  } catch {
    throw new Error(`Cannot reach the backend at ${API_URL}. Is it running?`);
  }

  const json: ApiResponse<T> = await res.json().catch(() => ({}));

  if (!res.ok || json.success === false) {
    const message =
      json?.error?.message ||
      json?.error?.detail ||
      json?.message ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }

  return json.data as T;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Cannot reach the backend at ${API_URL}. Is it running?`);
  }

  const json: ApiResponse<T> = await res.json().catch(() => ({}));

  if (!res.ok || json.success === false) {
    const message =
      json?.error?.message ||
      json?.error?.detail ||
      json?.message ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }

  return json.data as T;
}

async function del<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method: 'DELETE' });
  } catch {
    throw new Error(`Cannot reach the backend at ${API_URL}. Is it running?`);
  }

  const json: ApiResponse<T> = await res.json().catch(() => ({}));

  if (!res.ok || json.success === false) {
    const message =
      json?.error?.message ||
      json?.error?.detail ||
      json?.message ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }

  return json.data as T;
}

/** GET /api/campaigns — full campaign list including live engagement metrics
 * (delivered_count, opened_count, clicked_count, open_rate, click_rate)
 * computed by the backend from the email_logs table.
 */
export function fetchCampaignsFromApi(): Promise<CampaignLaunchApiRow[]> {
  return get('/api/campaigns');
}

// ─── Follow-up automation ─────────────────────────────────────────────────

export interface FollowupConfigPayload {
  is_active: boolean
  followup_mode: FollowupMode
  followup_campaign_id: string | null
}

export interface CreateFollowupConfigPayload {
  /** The ORIGINAL campaign whose openers become the follow-up recipients. */
  original_campaign_id: string
  /** Reuse an existing campaign as the follow-up (mutually exclusive with creating a new one). */
  followup_campaign_id?: string | null
  /** New follow-up campaign fields (used when followup_campaign_id is omitted). */
  campaign_name?: string
  subject_line?: string
  from_name?: string
  html_content?: string
  campaign_type?: string
  followup_mode: FollowupMode
  is_active: boolean
}

export interface UpdateFollowupConfigPayload {
  followup_mode?: FollowupMode
  is_active?: boolean
}

/** GET /api/followups — list configured follow-up relationships with decorators. */
export function fetchFollowupConfigs(): Promise<FollowupConfigRow[]> {
  return get('/api/followups');
}

/** POST /api/followups — create a follow-up (original + follow-up campaign). */
export function createFollowupConfig(
  payload: CreateFollowupConfigPayload
): Promise<FollowupConfigApiResult> {
  return post('/api/followups', payload);
}

/** PATCH /api/followups/:id — update follow-up mode / active state. */
export function updateFollowupConfig(
  configId: string,
  payload: UpdateFollowupConfigPayload
): Promise<FollowupConfig | null> {
  return patch(`/api/followups/${encodeURIComponent(configId)}`, payload);
}

/** DELETE /api/followups/:id — delete a follow-up configuration. */
export function deleteFollowupConfig(configId: string): Promise<FollowupConfig | null> {
  return del(`/api/followups/${encodeURIComponent(configId)}`);
}

/** GET /api/campaigns/:id/followup — fetch a campaign's follow-up settings. */
export function fetchFollowupConfig(campaignId: string): Promise<FollowupConfig | null> {
  return get(`/api/campaigns/${encodeURIComponent(campaignId)}/followup`);
}

/** POST /api/campaigns/:id/followup — create / update follow-up settings. */
export function saveFollowupConfig(
  campaignId: string,
  payload: FollowupConfigPayload
): Promise<FollowupConfig | null> {
  return post(`/api/campaigns/${encodeURIComponent(campaignId)}/followup`, payload);
}

/** GET /api/followups/pending — list follow-up records (manual queue + history). */
export function fetchPendingFollowups(): Promise<PendingFollowup[]> {
  return get('/api/followups/pending');
}

/** POST /api/followups/send/:id — send one pending follow-up now. */
export function sendPendingFollowup(id: string): Promise<{ id: string; status: string }> {
  return post(`/api/followups/send/${encodeURIComponent(id)}`, {});
}

/** GET /api/campaigns/:id/opened-contacts — contacts who opened the campaign. */
export function fetchOpenedContacts(campaignId: string): Promise<OpenedContact[]> {
  return get(`/api/campaigns/${encodeURIComponent(campaignId)}/opened-contacts`);
}

/** GET /api/followups/opened/all — union of opened contacts across all eligible campaigns (deduped). */
export function fetchOpenedContactsForAll(): Promise<OpenedContact[]> {
  return get('/api/followups/opened/all');
}

export interface SendSelectedFollowupsPayload {
  contact_ids: string[]
  followup_campaign_id: string | null
}

export interface SendSelectedFollowupResult {
  contact_id: string
  name: string
  email: string
  status: 'sent' | 'skipped' | 'failed'
  reason?: string
}

/** POST /api/campaigns/:id/followup/send-selected — send follow-up to the selected opened contacts. */
export function sendSelectedFollowups(
  campaignId: string,
  payload: SendSelectedFollowupsPayload
): Promise<SendSelectedFollowupResult[]> {
  return post(
    `/api/campaigns/${encodeURIComponent(campaignId)}/followup/send-selected`,
    payload
  );
}

export interface CampaignLaunchApiRow {
  id: string
  campaign_name: string
  subject_line: string | null
  from_name: string | null
  audience_segment: string | null
  campaign_type: string | null
  schedule_date: string | null
  schedule_time: string | null
  email_body: string | null
  html_content: string | null
  template_name: string | null
  status: string | null
  mailchimp_campaign_id: string | null
  recipient_count: number | null
  sent_at: string | null
  scheduled_at: string | null
  created_at: string | null
  updated_at: string | null
  delivered_count: number
  opened_count: number
  clicked_count: number
  open_rate: number
  click_rate: number
  /** Optional pre-rendered schedule text (not currently returned by the backend). */
  schedule_text?: string | null
}
