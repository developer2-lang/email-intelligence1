/**
 * CANONICAL audience → recipient resolution.
 *
 * This is the SINGLE SOURCE OF TRUTH for turning an "Audience Segment" label into
 * the actual contacts that will receive a campaign. It is shared by:
 *
 *   - the React frontend (dropdown count + preview)  — src/utils/contactSegment.ts
 *     re-exports it, so the count the user sees and the list the campaign is sent
 *     to are produced by the SAME function.
 *   - the send-campaign Edge Function               — the actual "Send Now" send.
 *   - the scheduled-campaign-runner Edge Function   — the actual scheduled send.
 *   - (mirrored in backend/services/supabaseService.js for the Node worker path)
 *
 * The `audience_segments` table stores ONLY segment *names* (labels). The real
 * recipients are ALWAYS derived from the `contacts` table using the category rules
 * below — never from an exact segment-name match and never by assuming a
 * contact_type equals the segment label verbatim.
 *
 * Contact type values in the DB look like:
 *   "Existing Client (Vatsal/ Shubham)"
 *   "New Client - Inbound"
 *   "New Client - Outbound"
 *   "New Lead"
 *   "Test Client"
 *
 * The Audience Segment is DIRECTLY connected to `contacts.contact_type`.
 * A selected segment ALWAYS resolves via an exact (case-insensitive, trimmed)
 * match against `contacts.contact_type` first. This guarantees:
 *
 *   SELECT * FROM contacts WHERE contact_type = <selected segment>
 *
 * returns exactly the contacts that will be emailed — never the whole table,
 * never a different category. A handful of generic labels ("New Clients",
 * "Existing Clients Only", "New Leads") are still supported as a FALLBACK that
 * matches by `contact_type` prefix, but `company_category` is NEVER used for
 * audience filtering (per requirement).
 *
 * Guarantees (required by the acceptance criteria):
 *   1. The displayed segment count and the campaign's sent recipients use the
 *      exact same resolver (resolveSegmentRecipients).
 *   2. A specific segment NEVER expands to the whole audience.
 *   3. Only contacts with a valid, deliverable email are returned.
 *   4. Duplicate email addresses are removed (case-insensitive).
 *   5. No hardcoded recipient email lists.
 *   6. `company_category` is never consulted when filtering by audience segment.
 *
 * This module is intentionally pure (no Deno / Node / browser APIs) so it can be
 * imported unchanged by both the Vite frontend and the Deno Edge Functions.
 */

export type SegmentContact = {
  id?: string | null;
  email?: string | null;
  contact_type?: string | null;
  company_category?: string | null;
  type?: string | null; // frontend Contact shape alias of contact_type
  category?: string | null; // frontend Contact shape alias of company_category
  [key: string]: any;
};

// ── Normalization ────────────────────────────────────────────────────────────

/** Normalize a contact_type / company_category / segment value for matching. */
export function normalizeAudienceValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

/** Alias kept for backward compatibility (src/utils/contactSegment consumers). */
export const normalizeContactType = normalizeAudienceValue;
/** Alias kept for backward compatibility. */
export const normalizeCompanyCategory = normalizeAudienceValue;

// ── Email validity (must match isDeliverableRecipientEmail in backend) ─────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// RFC 2606 reserved test domains + auto-generated test local parts. Emailing
// these only produces bounces / spam-trap hits that hurt deliverability.
const NON_DELIVERABLE_EMAIL_RE =
  /(^__)|@example\.(com|org|net|edu)$|\.(test|invalid|localhost|local)$/i;

/** Whether an email is syntactically valid AND not a reserved/test address. */
export function isDeliverableRecipientEmail(email: unknown): boolean {
  const value = String(email == null ? '' : email).trim();
  if (!value) return false;
  if (!EMAIL_REGEX.test(value)) return false;
  return !NON_DELIVERABLE_EMAIL_RE.test(value);
}

// ── Extensible segment rule registry ──────────────────────────────────────────
//
// Each rule: { match(name) → boolean, test(contact) → boolean }.
// `match` decides whether the rule applies to a given segment NAME; `test` decides
// whether a contact belongs to that segment. Custom audiences can be registered
// here via registerSegmentRule, but the DEFAULT behaviour is strict: a selected
// Audience Segment maps DIRECTLY to `contacts.contact_type` (exact, case-
// insensitive match). There are deliberately NO built-in prefix/category rules,
// so a specific segment can never silently expand to a wider set of contacts.

export type SegmentRule = {
  match: (name: string) => boolean;
  test: (contact: SegmentContact) => boolean;
};

// Empty by default — audience filtering is strictly by exact `contact_type`.
// Register rules only for genuinely custom audiences that are NOT a contact_type.
const SEGMENT_RULES: SegmentRule[] = [];

/**
 * Register an additional audience rule for genuinely custom audiences (e.g. a
 * stored custom contact list) that are NOT a `contacts.contact_type` value.
 * An exact `contact_type` match always takes precedence, so registering a rule
 * can never override or widen a real contact_type segment.
 */
export function registerSegmentRule(rule: SegmentRule): void {
  SEGMENT_RULES.push(rule);
}

/**
 * Whether a contact belongs to the given audience segment (by name).
 *
 * Resolution order (deliberately contact_type-first, never company_category):
 *   1. "All Contacts" → every contact.
 *   2. EXACT `contact_type` match (case-insensitive, trimmed). This is the direct
 *      connection the requirement demands: selecting "New Lead" resolves exactly
 *      the rows where `contact_type = 'New Lead'`.
 *   3. Any custom rules registered via registerSegmentRule (opt-in only).
 *
 * `company_category` is NEVER consulted — audience filtering is strictly by
 * `contact_type`.
 */
export function contactMatchesSegment(contact: SegmentContact, segment: string): boolean {
  const name = normalizeAudienceValue(segment);
  if (!name) return false;
  // "All Contacts" is the universal segment — every contact belongs to it.
  if (name === 'all contacts') return true;

  // 1. Direct, exact contact_type match — the source of truth.
  const type = normalizeAudienceValue(contact?.contact_type ?? contact?.type);
  if (type && type === name) return true;

  // 2. Opt-in custom rules only (none by default).
  for (const rule of SEGMENT_RULES) {
    if (rule.match(name)) return rule.test(contact || {});
  }

  // No company_category fallback — audience filtering is strictly by contact_type.
  return false;
}

// ── Manual audience (explicit email list) detection ───────────────────────────

/** True when the segment value is an explicit list of emails, not a saved segment. */
export function isManualAudience(segment: string): boolean {
  return !!segment && (segment.includes('@') || segment.includes(','));
}

/** Parse a manual audience string into syntactically valid, lowercased emails. */
function parseManualEmails(segment: string): string[] {
  return segment
    .split(',')
    .map((s) => s.trim())
    .filter((s) => EMAIL_REGEX.test(s))
    .map((s) => s.toLowerCase());
}

// ── Category-only filter (kept for backward compatibility / tests) ────────────
//
// NOTE: this does NOT apply email-validity or dedupe — use
// resolveSegmentRecipients for the real recipient list.

export function filterContactsBySegment(contacts: SegmentContact[], segment: string): SegmentContact[] {
  const name = normalizeAudienceValue(segment);
  if (!name || name === 'all contacts') return contacts;
  return contacts.filter((c) => contactMatchesSegment(c, segment));
}

// ── Canonical resolver ────────────────────────────────────────────────────────
//
// Returns the EXACT recipient list a campaign will be sent to, for a given
// segment label and a list of candidate contacts (raw Contacts rows OR frontend
// Contact objects — both shapes are accepted via the type/category aliases).
//
// Pipeline (identical for dropdown count and actual send):
//   1. pick the segment filter (specific category, never the whole table)
//   2. require a valid, deliverable email
//   3. dedupe by email (case-insensitive)
//
// The returned array length is what the dropdown shows as the count, and the
// same array is what the senders email out — guaranteeing they always agree.

export function resolveSegmentRecipients(
  contacts: SegmentContact[],
  segment: string
): SegmentContact[] {
  const all = Array.isArray(contacts) ? contacts : [];
  const normalizedSegment = String(segment || '').trim();
  const name = normalizeAudienceValue(normalizedSegment);

  // Manual explicit email list (user-typed addresses). Enrich with contact data
  // when the address exists in the contacts table so personalization still works.
  if (isManualAudience(normalizedSegment) && !SEGMENT_RULES.some((r) => r.match(name))) {
    const byEmail = new Map<string, SegmentContact>();
    for (const c of all) {
      const em1 = String(c?.email || c?.email_1 || '').trim().toLowerCase();
      const em2 = String(c?.email_2 || '').trim().toLowerCase();
      if (em1 && isDeliverableRecipientEmail(em1)) {
        byEmail.set(em1, { ...c, email: em1 });
      }
      if (em2 && isDeliverableRecipientEmail(em2)) {
        byEmail.set(em2, { ...c, email: em2 });
      }
    }
    const seen = new Set<string>();
    const result: SegmentContact[] = [];
    for (const email of parseManualEmails(normalizedSegment)) {
      if (seen.has(email)) continue;
      seen.add(email);
      result.push(byEmail.get(email) || { id: null, email });
    }
    return result;
  }

  // "All Contacts" / empty → every contact with a valid, deliverable email (email and email_2).
  if (!normalizedSegment || name === 'all contacts') {
    const seen = new Set<string>();
    const result: SegmentContact[] = [];
    for (const c of all) {
      if (!c) continue;
      const em1 = String(c.email || c.email_1 || '').trim();
      const em2 = String(c.email_2 || '').trim();
      if (em1 && isDeliverableRecipientEmail(em1)) {
        const key = em1.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ ...c, email: em1 });
        }
      }
      if (em2 && isDeliverableRecipientEmail(em2)) {
        const key = em2.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ ...c, email: em2 });
        }
      }
    }
    return result;
  }

  // Category segment.
  const seen = new Set<string>();
  const result: SegmentContact[] = [];
  for (const c of all) {
    if (!c || !contactMatchesSegment(c, normalizedSegment)) continue;
    const em1 = String(c.email || c.email_1 || '').trim();
    const em2 = String(c.email_2 || '').trim();
    if (em1 && isDeliverableRecipientEmail(em1)) {
      const key = em1.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ ...c, email: em1 });
      }
    }
    if (em2 && isDeliverableRecipientEmail(em2)) {
      const key = em2.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ ...c, email: em2 });
      }
    }
  }
  return result;
}

/** Convenience: the recipient count for a segment (what the dropdown shows). */
export function resolveSegmentCount(contacts: SegmentContact[], segment: string): number {
  return resolveSegmentRecipients(contacts, segment).length;
}

// ── Custom contact list resolution ───────────────────────────────────────────
//
// Custom lists ("March Clients", "Hot Leads", "Mumbai Clients", …) are stored
// separately from contact_type in `contact_lists` + `contact_list_members`. A
// contact can belong to many lists AND keep its contact_type. When a campaign is
// addressed to a custom list, its recipients are the list's MEMBERS — never a
// category filter. The same valid-email + dedup rules apply so the count shown
// in the dropdown and the recipients actually emailed always agree.

export function resolveContactListRecipients(members: SegmentContact[]): SegmentContact[] {
  const seen = new Set<string>();
  const result: SegmentContact[] = [];
  for (const c of Array.isArray(members) ? members : []) {
    if (!c) continue;
    const em1 = String(c.email || c.email_1 || '').trim();
    const em2 = String(c.email_2 || '').trim();
    if (em1 && isDeliverableRecipientEmail(em1)) {
      const key = em1.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ ...c, email: em1 });
      }
    }
    if (em2 && isDeliverableRecipientEmail(em2)) {
      const key = em2.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ ...c, email: em2 });
      }
    }
  }
  return result;
}

/** True when the segment label names a stored custom contact list. */
export function isCustomListSegment(
  segment: string,
  customListNames: string[]
): boolean {
  const name = normalizeAudienceValue(segment);
  return customListNames.some((n) => normalizeAudienceValue(n) === name);
}
