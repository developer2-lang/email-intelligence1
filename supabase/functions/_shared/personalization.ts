// ─── Dynamic per-recipient personalization ─────────────────────────────────
// Merge tags are resolved against the ACTUAL recipient row from
// `public.contacts`, so any column in that table can be used as a tag
// ({{full_name}}, {{email}}, {{company}}, {{designation}}, {{industry}},
// {{city}}, {{contact_type}}, {{company_category}}, {{notes}}, {{score}}, ...).
// The contact object is the source of truth — no hard-coded placeholder list.
const PLACEHOLDER_RE = /\{\{\s*([^{}\s]+(?:\s+[^{}\s]+)*)\s*\}\}/g;
/**
 * Normalizes a placeholder name so lookup is safe and case/whitespace
 * insensitive: trims, lowercases and collapses runs of whitespace to `_`
 * (so `{{First Name}}` resolves the `full_name` column, and `{{ first_name }}`
 * resolves `first_name`).
 */ export function normalizePlaceholderName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
}
/**
 * Safely converts any contact value to text. Null/undefined map to null (the
 * caller treats them as "known but empty"); arrays/objects become JSON.
 */ function valueToText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  } catch  {
    return String(value);
  }
}
function firstWord(value) {
  const parts = String(value || '').trim().split(/\s+/);
  return parts.length > 0 ? parts[0] : '';
}
// Data-driven aliases derived from actual contact columns. Not a per-content
// switch — it only maps synonymous tag names onto the column that already
// provides the value (the contacts table stores full_name, not first_name).
const CONTACT_ALIASES = [
  {
    name: 'name',
    source: 'full_name'
  },
  {
    name: 'first_name',
    source: 'full_name',
    transform: firstWord
  }
];
/**
 * Builds the placeholder→value lookup map for ONE contact row. Every column of
 * the row is registered under its normalized name; NULL/empty columns resolve
 * to '' (existing missing-value behaviour); unknown tags stay unresolved.
 */ export function buildContactLookup(contact, fallbackEmail) {
  const row = contact || {};
  const lookup = new Map();
  for (const [key, value] of Object.entries(row)){
    const normalized = normalizePlaceholderName(key);
    const text = valueToText(value);
    lookup.set(normalized, text === null ? '' : text);
  }
  // `{{email}}` still resolves when the contact row has no email address.
  if (!lookup.has('email')) {
    const fallback = valueToText(fallbackEmail);
    if (fallback) lookup.set('email', fallback);
  }
  for (const alias of CONTACT_ALIASES){
    const source = lookup.get(normalizePlaceholderName(alias.source));
    if (source === undefined) continue;
    lookup.set(alias.name, alias.transform ? alias.transform(source) : source);
  }
  return lookup;
}
function collectPlaceholders(template) {
  const names = [];
  const seen = new Set();
  String(template || '').replace(PLACEHOLDER_RE, (_match, name)=>{
    const normalized = normalizePlaceholderName(String(name));
    if (!seen.has(normalized)) {
      seen.add(normalized);
      names.push(normalized);
    }
    return _match;
  });
  return names;
}
/**
 * Personalize a subject/body template for ONE recipient.
 *
 * Every tag matching a `public.contacts` column (or a supported derived alias
 * such as {{first_name}} / {{name}}) is replaced with THAT contact's value.
 * Tags with no matching column are preserved verbatim. Never throws on
 * null/empty values or missing contact rows. Debug logs (opt-in via
 * PERSONALIZATION_DEBUG=1) never include credentials.
 */ export function personalizeTemplate(template, contact, fallbackEmail) {
  const lookup = buildContactLookup(contact, fallbackEmail);
  const resolved = [];
  const result = String(template || '').replace(PLACEHOLDER_RE, (match, name)=>{
    const key = normalizePlaceholderName(String(name));
    const value = lookup.get(key);
    if (value === undefined) return match; // unknown tag → preserved
    resolved.push(key);
    return value;
  });
  if (Deno.env.get('PERSONALIZATION_DEBUG') === '1') {
    const placeholders = collectPlaceholders(template);
    if (placeholders.length > 0) {
      const email = valueToText(contact && contact.email) || valueToText(fallbackEmail) || '';
      console.log(`[Personalization] recipient=${email}`);
      console.log(`[Personalization] placeholders=[${placeholders.join(', ')}]`);
      console.log(`[Personalization] resolved=${resolved.length}`);
    }
  }
  return result;
}
