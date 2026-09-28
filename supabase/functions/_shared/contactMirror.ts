// Mirrors public.leads rows into public.contacts so Lead Search results also
// appear on the Contacts page under the "lead search" contact type.
// Prerequisite (applied once in SQL): contacts needs a linkedin_url column plus
// a NON-partial UNIQUE index on it so upsert dedupes:
//
//   alter table public.contacts add column if not exists linkedin_url text;
//   create unique index if not exists contacts_linkedin_url_key
//     on public.contacts (linkedin_url);
//
// The index must NOT be partial. `ON CONFLICT (linkedin_url)` carries no index
// predicate, and Postgres only infers a partial unique index when the statement
// supplies one — which PostgREST's on_conflict cannot do. A partial index here
// makes every mirror fail with 42P10. Postgres allows repeated NULLs in a unique
// index, so contacts without a linkedin_url are still fine.

const LEAD_SEARCH_TYPE = "lead search";

// Postgres codes that mean "this row already exists / cannot be arbitrated"
// rather than "the mirror failed". Both are expected during a lead save and
// must never propagate up and fail the lead write.
const DUPLICATE_ROW = "23505"; // unique_violation
const NO_CONFLICT_TARGET = "42P10"; // no unique/exclusion constraint matches ON CONFLICT

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
    // IMPORTANT: use null (not "") for missing email.
    // contacts has a UNIQUE constraint on email; storing "" for every lead
    // without an email collides on the second insert (23505 error).
    // Postgres allows multiple NULLs in a unique index so null is safe.
    email: cleanStr(row.email) ?? null,
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
 *
 * Two ways this can fail without the database being at fault:
 *   1. contacts.email is unique (lower(trim(email)), partial). A row whose
 *      linkedin_url is brand new but whose email already belongs to another
 *      contact raises 23505 on the batched upsert.
 *   2. ON CONFLICT ("linkedin_url") is only satisfiable by a NON-partial
 *      unique index. A partial index (… WHERE linkedin_url IS NOT NULL)
 *      cannot be inferred without an index predicate, which PostgREST's
 *      on_conflict cannot express, so Postgres rejects the whole statement
 *      with 42P10.
 *
 * Either way the batch is retried as plain per-row INSERTs: no ON CONFLICT
 * clause means no arbiter to infer, and a 23505 on a single row is swallowed
 * so only that row is skipped. The lead save never fails.
 */
export async function upsertContactMirrors(
  client: any,
  rows: Record<string, any>[]
): Promise<{ error: any }> {
  const list = rows.filter((r) => cleanStr(r.linkedin_url));
  if (list.length === 0) return { error: null };

  // Preferred path: also refreshes an existing mirrored contact in place.
  const { error } = await client
    .from("contacts")
    .upsert(list, { onConflict: "linkedin_url" });

  if (!error) return { error: null };
  if (error.code !== DUPLICATE_ROW && error.code !== NO_CONFLICT_TARGET) {
    return { error };
  }

  console.warn(
    `[contactMirror] batch upsert rejected (${error.code}: ${error.message}) — ` +
      `retrying ${list.length} row(s) as plain inserts`,
  );

  for (const row of list) {
    // Ensure email is null (not "") on per-row fallback inserts too.
    const safeRow = { ...row, email: row.email || null };
    const { error: rowErr } = await client.from("contacts").insert(safeRow);
    if (rowErr && rowErr.code !== DUPLICATE_ROW) return { error: rowErr };
  }
  return { error: null };
}
