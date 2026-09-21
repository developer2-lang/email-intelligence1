// Mirrors public.leads rows into public.contacts so Lead Search results also
// appear on the Contacts page under the "lead search" contact type.
// Prerequisite (applied once in SQL): contacts needs a linkedin_url column plus
// a UNIQUE index on it (partial, ignoring NULLs) so upsert dedupes:
//
//   alter table public.contacts add column if not exists linkedin_url text;
//   create unique index if not exists contacts_linkedin_url_key
//     on public.contacts (linkedin_url) where linkedin_url is not null;

const LEAD_SEARCH_TYPE = "lead search";

function cleanStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** Map a public.leads row to the equivalent public.contacts row. */
export function leadToContactRow(row: Record<string, any>): Record<string, any> {
  return {
    linkedin_url: cleanStr(row.linkedin_url),
    full_name: cleanStr(row.full_name) ?? "",
    company: cleanStr(row.company_name) ?? "",
    email: cleanStr(row.email) ?? "",
    designation: cleanStr(row.designation),
    industry: cleanStr(row.industry),
    geography: cleanStr(row.geography),
    role: cleanStr(row.role),
    job_title: cleanStr(row.job_title),
    phone: cleanStr(row.phone),
    contact_type: LEAD_SEARCH_TYPE,
    company_category: LEAD_SEARCH_TYPE,
  };
}

/**
 * Upsert contact rows on linkedin_url (dedupe target). Rows without a
 * linkedin_url are ignored. Accepts already-shaped contact objects, so
 * partial updates (e.g. only email/phone from enrichment) work too and only
 * touch the provided columns.
 */
export async function upsertContactMirrors(
  client: any,
  rows: Record<string, any>[]
): Promise<{ error: any }> {
  const list = rows.filter((r) => cleanStr(r.linkedin_url));
  if (list.length === 0) return { error: null };
  const { error } = await client.from("contacts").upsert(list, { onConflict: "linkedin_url" });
  return { error };
}