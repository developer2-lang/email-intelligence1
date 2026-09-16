/**
 * Supabase data-access layer used by the backend.
 *
 * Provides a shared Supabase client and campaign/contact CRUD.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.R_SUPABASE_URL;
const SUPABASE_KEY = process.env.R_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const CAMPAIGNS_TABLE = 'campaigns';
const CONTACTS_TABLE = 'contacts';
const CAMPAIGN_CONTACTS_TABLE = 'campaign_contacts';
const ANALYTICS_TABLE = 'campaign_analytics';
const SCHEDULE_TABLE = 'campaign_schedules';

/**
 * Validate environment variables at startup.
 */
(function validateEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)');
  if (!process.env.R_EMAIL_HOST) missing.push('R_EMAIL_HOST');
  if (!process.env.R_EMAIL_PORT) missing.push('R_EMAIL_PORT');
  if (!process.env.R_EMAIL_USER) missing.push('R_EMAIL_USER');
  if (!process.env.R_EMAIL_PASSWORD) missing.push('R_EMAIL_PASSWORD');
  if (missing.length > 0) {
    console.error('═══════════════════════════════════════════════════════════');
    console.error('  FATAL: Missing required environment variables:');
    console.error(`  ${missing.join(', ')}`);
    console.error('  Add these to your backend/.env file.');
    console.error('═══════════════════════════════════════════════════════════');
  } else {
    console.log('[Env] All required environment variables are set');
    console.log(`[Env] SUPABASE_URL: ${SUPABASE_URL}`);
    console.log(`[Env] SUPABASE_KEY: ${SUPABASE_KEY.substring(0, 12)}...`);
    console.log(`[Env] R_EMAIL_HOST: ${process.env.R_EMAIL_HOST}`);
    console.log(`[Env] R_EMAIL_PORT: ${process.env.R_EMAIL_PORT}`);
    console.log(`[Env] R_EMAIL_USER: ${process.env.R_EMAIL_USER}`);
  }
})();

let _supabase = null;

/**
 * Lazily create the Supabase client.
 */
function getSupabase() {
  if (!_supabase) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      const error = new Error(
        'Missing Supabase configuration: ' +
        [!SUPABASE_URL && 'SUPABASE_URL', !SUPABASE_KEY && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean).join(', ') +
        '. Add these values to your backend/.env file.'
      );
      error.status = 500;
      throw error;
    }
    _supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

function toError(error, fallback) {
  const wrapped = new Error((error && error.message) || fallback);
  wrapped.status = 500;
  wrapped.supabase = true;
  return wrapped;
}

/**
 * Export the Supabase client instance.
 * Named export: import { supabase } from "./supabaseService.js";
 */
export const supabase = getSupabase();

// ─── Column-presence guard (graceful rollout) ───────────────────────────────
// The template-reference columns (campaigns.template_id,
// sequence_steps.normal_template_id/increment_template_id,
// sequence_branch_steps.template_id) are added by a migration the operator runs
// manually. Until it runs, inserting/updating those columns fails with "column
// does not exist". This cache lets callers omit them safely: one cheap probe
// per (table, column) per process, then the result is reused.

const _columnPresenceCache = new Map();

/**
 * Whether a table currently has the given column. Never throws — a missing
 * table/column resolves to false so callers can degrade gracefully.
 *
 * @param {string} tableName
 * @param {string} columnName
 * @returns {Promise<boolean>}
 */
export async function hasTableColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (_columnPresenceCache.has(key)) return _columnPresenceCache.get(key);
  const client = getSupabase();
  const promise = client
    .from(tableName)
    .select(columnName)
    .limit(1)
    .then(() => true)
    .catch(() => false);
  _columnPresenceCache.set(key, promise);
  return promise;
}

// ─── Campaign CRUD ────────────────────────────────────────────────────────

export async function saveCampaign(record) {
  const client = getSupabase();
  const { id, ...fields } = record;
  const base = { ...fields, updated_at: new Date().toISOString() };

  // Omit template_id until the migration adding the column has been applied.
  if (!(await hasTableColumn(CAMPAIGNS_TABLE, 'template_id'))) {
    delete base.template_id;
  }

  if (id) {
    const { data, error } = await client
      .from(CAMPAIGNS_TABLE)
      .update(base)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to update campaign');
    return data;
  }

  const { data, error } = await client
    .from(CAMPAIGNS_TABLE)
    .insert({ ...base, created_at: new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to save campaign');
  return data;
}

export async function getCampaign(id) {
  const client = getSupabase();
  const { data, error } = await client
    .from(CAMPAIGNS_TABLE)
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw toError(error, 'Failed to fetch campaign');
  return data;
}

export async function listCampaigns() {
  const client = getSupabase();
  const { data, error } = await client
    .from(CAMPAIGNS_TABLE)
    .select('*')
    .neq('campaign_type', 'sequence')
    .order('created_at', { ascending: false });
  if (error) throw toError(error, 'Failed to list campaigns');
  return data || [];
}

export async function deleteCampaign(id) {
  const client = getSupabase();
  await client.from('email_logs').delete().eq('campaign_id', id);
  await client.from(CAMPAIGN_CONTACTS_TABLE).delete().eq('campaign_id', id);
  await client.from(ANALYTICS_TABLE).delete().eq('campaign_id', id);
  // Follow-up automation: clear config + log rows that reference this campaign
  // either as the original campaign or as the follow-up campaign. Best-effort —
  // these tables are optional and may not exist yet.
  await client.from('campaign_followup_logs').delete().or(`campaign_id.eq.${id},followup_campaign_id.eq.${id}`);
  await client.from('campaign_followups').delete().or(`campaign_id.eq.${id},followup_campaign_id.eq.${id}`);
  const { error } = await client.from(CAMPAIGNS_TABLE).delete().eq('id', id);
  if (error) throw toError(error, 'Failed to delete campaign');
  return true;
}

export async function updateCampaignStatus(id, updates) {
  const client = getSupabase();
  const { data, error } = await client
    .from(CAMPAIGNS_TABLE)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to update campaign status');
  return data;
}

/**
 * Fetch one row from the `templates` table by id (or null when missing).
 * Used at send time to resolve the ORIGINAL HTML a campaign/sequence step was
 * authored from — the saved body is only a copy, so the send path reads the
 * template's current content.
 *
 * @param {string} templateId
 * @returns {Promise<object|null>}
 */
export async function fetchTemplateById(templateId) {
  if (!templateId) return null;
  const client = getSupabase();
  const { data, error } = await client
    .from('templates')
    .select('*')
    .eq('id', templateId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch template');
  return data;
}

/**
 * Resolve the ORIGINAL HTML for a template id:
 *  - storage-backed templates (template_source='storage') download their HTML
 *    file from Storage (storage_bucket / storage_path) and return it;
 *  - database-backed templates return the `body` column.
 * Returns null when the template is missing. Falls back to the `body` column
 * when a storage file cannot be downloaded.
 *
 * @param {string} templateId
 * @returns {Promise<string|null>}
 */
export async function fetchTemplateHtml(templateId) {
  if (!templateId) return null;
  const template = await fetchTemplateById(templateId);
  if (!template) return null;

  if (template.template_source === 'storage' && template.storage_bucket && template.storage_path) {
    try {
      const { data, error } = await supabase.storage
        .from(template.storage_bucket)
        .download(template.storage_path);
      if (error) {
        console.warn(
          `[Supabase] Failed to download template file ${template.storage_path}: ${error.message} — falling back to templates.body`
        );
        return template.body || null;
      }
      const text = await data.text();
      return String(text || '').trim() ? text : template.body || null;
    } catch (err) {
      console.warn(
        `[Supabase] Template download error for ${template.storage_path}: ${err.message} — falling back to templates.body`
      );
      return template.body || null;
    }
  }

  return template.body || null;
}

// ─── Campaign schedules (recurring) ────────────────────────────────────────

/**
 * Replace the active schedule row for a campaign with a fresh one.
 *
 * Deletes any prior campaign_schedules rows for the campaign, then inserts the
 * new row, so each campaign keeps exactly one schedule. The caller passes a
 * fully-formed row (columns match the DB table, including next_run).
 *
 * @param {string} campaignId
 * @param {object} row  Schedule columns keyed in snake_case.
 * @returns {Promise<object>} The inserted schedule row.
 */
export async function replaceCampaignSchedule(campaignId, row) {
  const client = getSupabase();
  const { error: deleteError } = await client
    .from(SCHEDULE_TABLE)
    .delete()
    .eq('campaign_id', campaignId);
  if (deleteError) throw toError(deleteError, 'Failed to clear previous campaign schedule');

  const { data, error } = await client
    .from(SCHEDULE_TABLE)
    .insert({ campaign_id: campaignId, ...row })
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to save campaign schedule');
  return data;
}

/**
 * Fetch all active recurring schedules (for the scheduler to process).
 *
 * @returns {Promise<Array<object>>}
 */
export async function listActiveSchedules() {
  const client = getSupabase();
  const { data, error } = await client
    .from(SCHEDULE_TABLE)
    .select('*')
    .eq('is_active', true)
    .not('schedule_type', 'eq', 'one_time');
  if (error) throw toError(error, 'Failed to list campaign schedules');
  return data || [];
}

// ─── Campaign analytics ────────────────────────────────────────────────────

/**
 * Fetch the campaign_analytics row for one campaign.
 * Returns null when no row exists (e.g. drafts that were never sent).
 */
export async function getCampaignAnalytics(campaignId) {
  const client = getSupabase();
  const { data, error } = await client
    .from(ANALYTICS_TABLE)
    .select('*')
    .eq('campaign_id', campaignId)
    .maybeSingle();
  if (error && error.code === '42P01') return null;
  if (error) throw toError(error, 'Failed to fetch campaign analytics');
  return data || null;
}

/**
 * Fetch campaign_analytics rows for many campaigns in one query.
 * Returns a map keyed by campaign_id. Missing campaigns are absent from the map.
 */
export async function getAnalyticsForCampaigns(campaignIds) {
  const client = getSupabase();
  if (!campaignIds || campaignIds.length === 0) return {};

  const { data, error } = await client
    .from(ANALYTICS_TABLE)
    .select('*')
    .in('campaign_id', campaignIds);
  if (error && error.code === '42P01') return {};
  if (error) throw toError(error, 'Failed to fetch campaign analytics');

  const byCampaign = {};
  for (const row of data || []) byCampaign[row.campaign_id] = row;
  return byCampaign;
}

/**
 * Upsert a campaign_analytics row. Inserting when the campaign has no row yet,
 * updating it when it does. open_rate / click_rate are recomputed from the
 * passed opened / clicked / delivered counts.
 */
export async function upsertCampaignAnalytics(entry) {
  const client = getSupabase();
  const delivered = Number(entry.delivered) || 0;
  const opened = Number(entry.opened) || 0;
  const clicked = Number(entry.clicked) || 0;

  const row = {
    campaign_id: entry.campaign_id,
    total_recipients: Number(entry.total_recipients) || 0,
    delivered,
    opened,
    clicked,
    open_rate: delivered > 0 ? Number(((opened / delivered) * 100).toFixed(1)) : 0,
    click_rate: delivered > 0 ? Number(((clicked / delivered) * 100).toFixed(1)) : 0,
  };

  const { data, error } = await client
    .from(ANALYTICS_TABLE)
    .upsert(row, { onConflict: 'campaign_id' })
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to upsert campaign analytics');
  return data;
}

// ─── Contacts ──────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// RFC 2606 reserved test domains + auto-generated test local parts (e.g.
// __acceptance_<ts>_a0@example.com). Emailing these can only produce bounces
// or spam-trap hits that hurt Gmail deliverability for the whole account.
const NON_DELIVERABLE_EMAIL_RE =
  /(^__)|@example\.(com|org|net|edu)$|\.(test|invalid|localhost|local)$/i;

/**
 * Whether an email address is safe to send to: syntactically valid AND not a
 * reserved/test address (example.com/org/net/edu, .test/.invalid/.localhost/
 * .local, or auto-generated local parts like `__acceptance_...`). Empty,
 * malformed and test addresses are skipped so real recipients never receive
 * mail to throwaway addresses.
 *
 * @param {*} email
 * @returns {boolean}
 */
export function isDeliverableRecipientEmail(email) {
  const value = String(email || '').trim();
  if (!value) return false;
  if (!EMAIL_REGEX.test(value)) return false;
  return !NON_DELIVERABLE_EMAIL_RE.test(value);
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export async function fetchContacts(filter = {}) {
  const client = getSupabase();
  let query = client.from(CONTACTS_TABLE).select('*');
  for (const [column, value] of Object.entries(filter)) {
    query = query.eq(column, value);
  }
  const { data, error } = await query;
  if (error) throw toError(error, 'Failed to fetch contacts');
  return data || [];
}

export async function getContactById(id) {
  const client = getSupabase();
  const { data, error } = await client
    .from(CONTACTS_TABLE)
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw toError(error, 'Failed to fetch contact');
  return data;
}

// ─── Campaign ↔ Contacts linkage ──────────────────────────────────────────

/**
 * Canonical follow-up recipient resolver.
 *
 * Determines whether `followupCampaignId` is configured as a FOLLOW-UP campaign.
 * The canonical relationship is:
 *
 *   campaign_followups.campaign_id            = ORIGINAL campaign id
 *   campaign_followups.followup_campaign_id   = FOLLOW-UP campaign id
 *
 * A campaign is a follow-up when a row exists with
 * `followup_campaign_id = followupCampaignId`. When it is, the ONLY eligible
 * recipients are the contacts who opened the ORIGINAL campaign:
 *
 *   email_logs WHERE campaign_id = source AND opened = true
 *
 * This NEVER falls back to the campaign's normal audience segment — a follow-up
 * either goes to its openers or to nobody.
 *
 * @param {string} followupCampaignId
 * @returns {Promise<{isFollowup: boolean, sourceCampaignId: string|null, contacts: Array<object>}>}
 */
export async function resolveFollowupRecipients(followupCampaignId) {
  const client = getSupabase();
  const notFollowup = () => ({ isFollowup: false, sourceCampaignId: null, contacts: [] });

  if (!followupCampaignId) return notFollowup();

  const { data: configs, error } = await client
    .from('campaign_followups')
    .select('campaign_id')
    .eq('followup_campaign_id', followupCampaignId)
    .limit(1);
  if (error) {
    if (error.code === '42P01') return notFollowup(); // table not created yet
    throw toError(error, 'Failed to check follow-up configuration');
  }

  const config = configs && configs[0];
  if (!config || !config.campaign_id) return notFollowup();

  const sourceCampaignId = config.campaign_id;

  const { data: openedLogs, error: openedError } = await client
    .from('email_logs')
    .select('contact_id')
    .eq('campaign_id', sourceCampaignId)
    .eq('opened', true);
  if (openedError) throw toError(openedError, 'Failed to fetch opened contacts for follow-up');

  const openedContactIds = new Set((openedLogs || []).map((r) => r.contact_id));
  let contacts = [];
  if (openedContactIds.size > 0) {
    const { data: rows, error: contactsError } = await client
      .from(CONTACTS_TABLE)
      .select('*')
      .in('id', [...openedContactIds]);
    if (contactsError) throw toError(contactsError, 'Failed to fetch follow-up recipient contacts');
    contacts = (rows || []).filter((c) => isDeliverableRecipientEmail(c.email));
  }

  return { isFollowup: true, sourceCampaignId, contacts };
}

/**
 * Link a single contact to a campaign in campaign_contacts (idempotent).
 * Used by the follow-up send paths so a follow-up campaign's campaign_contacts
 * contains ONLY the contacts that actually receive the follow-up.
 */
export async function linkContactToCampaign(campaignId, contactId) {
  const client = getSupabase();
  const { data: existing, error: existingError } = await client
    .from(CAMPAIGN_CONTACTS_TABLE)
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('contact_id', contactId)
    .limit(1);
  if (existingError && existingError.code !== '42P01') {
    throw toError(existingError, 'Failed to check existing campaign contact');
  }
  if (existing && existing.length > 0) return;

  const { error: insertError } = await client
    .from(CAMPAIGN_CONTACTS_TABLE)
    .insert({ campaign_id: campaignId, contact_id: contactId });
  if (insertError && insertError.code !== '42P01') {
    throw toError(insertError, 'Failed to link contact to campaign');
  }
}

export async function resolveContactsForCampaign(campaignId, audienceSegment) {
  const client = getSupabase();

  const followup = await resolveFollowupRecipients(campaignId);

  let valid;
  if (followup.isFollowup) {
    // Strict follow-up rule: ONLY the contacts who opened the ORIGINAL
    // campaign. Never the full audience segment. If nobody opened, the
    // follow-up gets 0 recipients and is NOT sent.
    valid = followup.contacts;
    if (valid.length === 0) {
      console.warn(
        `[Supabase] Campaign ${campaignId} is a follow-up of ${followup.sourceCampaignId} — ` +
        'no opened recipients found. Resolution returns 0; the follow-up will NOT be sent to the audience.'
      );
    }
  } else {
    const contacts = await resolveContactsForAudience(audienceSegment);
    // Recipient quality: skip empty, malformed, reserved/test addresses AND
    // duplicate addresses within the same campaign (two contacts sharing one
    // email must never both receive the same campaign).
    const seenEmails = new Set();
    valid = (contacts || []).filter((c) => {
      if (!isDeliverableRecipientEmail(c.email)) return false;
      const key = normalizeEmail(c.email);
      if (seenEmails.has(key)) return false;
      seenEmails.add(key);
      return true;
    });
  }

  if (valid.length > 0) {
    const { data: existing, error: existingError } = await client
      .from(CAMPAIGN_CONTACTS_TABLE)
      .select('contact_id')
      .eq('campaign_id', campaignId);
    if (existingError) throw toError(existingError, 'Failed to fetch existing campaign contacts');

    const existingIds = new Set((existing || []).map((r) => r.contact_id));
    const newRows = valid
      .filter((c) => !existingIds.has(c.id))
      .map((c) => ({ campaign_id: campaignId, contact_id: c.id }));

    if (newRows.length > 0) {
      const { error: insertError } = await client
        .from(CAMPAIGN_CONTACTS_TABLE)
        .insert(newRows);
      if (insertError) throw toError(insertError, 'Failed to link campaign contacts');
    }
  }

  return valid;
}

/**
 * Resolve the contacts for an audience label. Shared by campaign sends and
 * sequence enrollment.
 *
 * The audience segment is based directly on contacts.contact_type.
 * - "All Contacts" → every contact (no filter)
 * - Any other segment → filter by contact_type = segment value
 */
export async function resolveContactsForAudience(audienceSegment) {
  const client = getSupabase();
  const segment = String(audienceSegment || '').trim();

  let query = client.from(CONTACTS_TABLE).select('*');

  if (segment && segment !== 'All Contacts') {
    // Filter by contact_type exactly matching the selected audience segment
    query = query.eq('contact_type', segment);
  }

  const { data: contacts, error } = await query;
  if (error) throw toError(error, 'Failed to fetch contacts for audience');

  return contacts || [];
}
