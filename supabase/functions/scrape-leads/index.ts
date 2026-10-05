import { withSupabase } from "@supabase/server";
import { createClient } from "npm:@supabase/supabase-js@2";
import { leadToContactRow, upsertContactMirrors } from "../_shared/contactMirror.ts";

console.log("🔑 env check:", { url: !!Deno.env.get("SUPABASE_URL"), key: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") });

// Error carrying an HTTP status, so the catch block below can answer 401
// instead of flattening every failure into a 400.
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The subset of SupabaseContext this function needs. Declared structurally so
// the helper stays independent of the SDK's generic Database parameter.
interface UserContext {
  userClaims?: { id?: string } | null;
  jwtClaims?: { sub?: string } | null;
  authMode?: string;
}

// Resolve the caller's user id from the VERIFIED claims that withSupabase puts
// on the context — never from a hand-decoded Authorization header.
//
// `leads.user_id` is covered by RLS (`auth.uid() = user_id`), so a row saved
// with user_id = NULL is invisible to every user of the app: the Edge Function
// reports a successful save while the table never shows the new lead. Failing
// loudly is the only safe outcome when no verified user is present.
function requireUserId(ctx: UserContext): string {
  const candidate = ctx?.userClaims?.id ?? ctx?.jwtClaims?.sub;
  if (typeof candidate === "string" && UUID_RE.test(candidate)) return candidate;
  throw new HttpError(
    401,
    `Unauthorized — no verified user on this request (authMode=${ctx?.authMode ?? "unknown"}). ` +
      `Sign in and retry.`,
  );
}

// Stage 1 mappings against the profile scraper's actual response shape
// (firstName/lastName, headline, currentPosition[], location, linkedinUrl).
// email and phone are intentionally NOT mapped here — they come from Stage 2
// (enrich-lead).

function extractFullName(profile: any): string {
  return (
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
    profile.fullName ||
    profile.name ||
    ""
  );
}

function extractCurrentPosition(profile: any): any {
  return Array.isArray(profile.currentPosition) ? profile.currentPosition[0] : null;
}

function extractCompany(profile: any): string {
  const current = extractCurrentPosition(profile);
  return current?.companyName || profile.companyName || profile.company || profile.currentCompany || "";
}

function extractDesignation(profile: any): string {
  return profile.headline || profile.occupation || profile.title || profile.position || "";
}

// Dedicated current job title / current position field. Checks the field names
// this actor family actually returns for the profile's current position, in
// priority order (dedicated job-title fields first). Never generates a value.
function extractJobTitle(profile: any): string {
  const current = extractCurrentPosition(profile);
  return (
    current?.position ||
    profile.jobTitle ||
    profile.job_title ||
    profile.currentJobTitle ||
    profile.currentTitle ||
    profile.position ||
    profile.title ||
    ((Array.isArray(profile.experience) && profile.experience[0]?.title) ? profile.experience[0].title : "") ||
    ""
  );
}

// role → currentPosition[0].position, falling back to headline. Following the
// Stage-1 spec; distinct from designation thanks to the dedicated position field.
function extractRole(profile: any): string {
  const current = extractCurrentPosition(profile);
  return current?.position || profile.role || profile.headline || "";
}

function stripToNull(value: any): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function toLeadRow(profile: any, userId: string, searchQuery: string, industry: string, roleFilter: string) {
  const jobTitle = stripToNull(extractJobTitle(profile));
  const row: Record<string, any> = {
    user_id: userId,
    linkedin_url: stripToNull(profile.linkedinUrl || profile.profileUrl || profile.url),
    full_name: stripToNull(extractFullName(profile)),
    company_name: stripToNull(extractCompany(profile)),
    designation: stripToNull(extractDesignation(profile)),
    role: roleFilter || "",
    headline: stripToNull(extractDesignation(profile)),
    location: stripToNull(profile.location?.linkedinText || profile.location),
    geography: stripToNull(profile.location?.linkedinText || profile.location?.parsed?.country),
    industry: industry || "",
    source_query: searchQuery,
  };
  // email and phone are deliberately ABSENT from this object, not set to null.
  // A key that is absent from the payload is not part of the generated
  // `DO UPDATE SET` list, so re-searching a person keeps whatever enrich-lead
  // already found. Writing `email: null` explicitly would wipe the enriched
  // address on every repeat search. On a fresh INSERT the column falls back to
  // its default (NULL) either way, so a brand new lead still lands with a NULL
  // email — and never an empty string, which is what stage 1 used to risk.
  //
  // Only write job_title when the scraper actually provided a current position —
  // an omitted key on UPSERT keeps any previously saved value instead of nulling it.
  if (jobTitle) row.job_title = jobTitle;
  return row;
}

export default {
  fetch: withSupabase({ auth: ["user", "publishable", "secret"] }, async (req, ctx) => {
    // CORS headers so your React app can call this function
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    try {
      // 0. Resolve the caller BEFORE anything expensive happens. A request with
      //    no verified user is rejected here, so an unauthenticated caller can
      //    never spend Apify credits or write a row nobody can read back.
      const userId = requireUserId(ctx);
      console.log("✅ Caller resolved:", userId, "via authMode:", ctx?.authMode);

      // 1. Get the filters from the React form
      const body = (await req.json().catch(() => ({}))) ?? {};
      const filters = body.filters ?? body ?? {};
      console.log("✅ Filters received:", filters);

      // 2. Read secrets from Supabase
      const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");
      const ACTOR_ID = Deno.env.get("APIFY_ACTOR_ID") || "harvestapi/linkedin-profile-search";

      const company = String(filters.company || '').trim();
      const industry = String(filters.industry || '').trim();
      const designation = String(filters.designation || '').trim();
      const role = String(filters.role || '').trim();
      const geography = String(filters.geography || '').trim();
      const state = String(filters.state || '').trim();
      const maxItems = Number(filters.maxItems ?? filters.maxResults ?? filters.numProfiles ?? 10) || 10;

      // Build searchQuery by joining all non-empty values from [company, designation, industry, role]
      const searchQuery = [company, designation, industry, role].filter(Boolean).join(' ') || 'CEO';

      const currentCompanies = company ? [company] : [];
      const locations = [state ? (geography ? `${state}, ${geography}` : state) : geography].filter(Boolean);

      const apifyInput = {
        searchQuery: searchQuery,
        currentCompanies: currentCompanies,
        locations: locations,
        maxItems: maxItems || 10,
        profileScraperMode: "Full",
      };

      console.log("📤 Sending to Apify:", apifyInput);

      // 5. Call the Apify API
      const response = await fetch(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(apifyInput),
        }
      );

      if (!response.ok) {
        const errBody = await response.text();
        console.error(`❌ Apify ${response.status}:`, errBody);
        throw new Error(`Apify call failed (${response.status})`);
      }

      const data = await response.json();
      console.log("📥 Apify response:", data);

      // 6. Profiles returned by the actor — strictly filter by currentCompanies
      const scrapedProfiles = Array.isArray(data) ? data : (data.data ?? []);
      const profiles = currentCompanies.length > 0
        ? scrapedProfiles.filter((profile: any) => {
            const comp = extractCompany(profile).toLowerCase().trim();
            const target = company.toLowerCase();
            const headline = (extractDesignation(profile) || '').toLowerCase();
            return (
              comp === target ||
              comp.includes(target) ||
              target.includes(comp) ||
              headline.includes(`@ ${target}`) ||
              headline.includes(`at ${target}`)
            );
          })
        : scrapedProfiles;

      // 7. Cleaned shape for the frontend (kept for compatibility).
      const cleanedArray = profiles
        .filter((profile: any) => !!(profile.linkedinUrl || profile.profileUrl || profile.url))
        .map((profile: any) => ({
          linkedinUrl: profile.linkedinUrl || profile.profileUrl || profile.url || "",
          full_name: extractFullName(profile),
          company_name: extractCompany(profile),
          job_title: extractJobTitle(profile),
          designation: extractDesignation(profile),
          role: extractRole(profile),
          geography: profile.location?.linkedinText || profile.location?.parsed?.country || "",
        }));

      // 8. Rows to persist. user_id is the verified caller's id (resolved in
      //     step 0) so the RLS policy `auth.uid() = user_id` lets this user read
      //     back exactly what they just saved.
      const rows = profiles
        .map((profile: any) => toLeadRow(profile, userId, searchQuery, filters.industry, filters.role))
        .filter((row: any) => row.linkedin_url);

      let savedCount = 0;
      if (rows.length > 0) {
        const serviceClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        // A lead is identified solely by linkedin_url, and (user_id, linkedin_url)
        // is the only conflict target the table offers — so dedupe on that pair
        // and nothing else. No email matching, no prefilter SELECT.
        //
        // This is not about the unique constraints; it is a Postgres limitation.
        // A single ON CONFLICT DO UPDATE statement aborts with 21000 ("ON
        // CONFLICT DO UPDATE command cannot affect row a second time") if it
        // carries the same conflict key twice. user_id is identical across the
        // whole batch, so one row per linkedin_url is what makes a bulk upsert
        // safe to send at all.
        const seenUrls = new Set<string>();
        const rowsToSave = rows.filter((row: any) => {
          if (seenUrls.has(row.linkedin_url)) return false;
          seenUrls.add(row.linkedin_url);
          return true;
        });
        const collapsedCount = rows.length - rowsToSave.length;
        if (collapsedCount > 0) {
          console.log(`ℹ️ Collapsed ${collapsedCount} repeated profile(s) from this batch.`);
        }

        console.log(`📤 UPSERT PAYLOAD — ${rowsToSave.length} row(s):`, JSON.stringify(rowsToSave, null, 2));

        // One statement. Anything with a linkedin_url lands: a new person is
        // INSERTed, a person already stored under this user is UPDATED in
        // place. There is no path that silently discards a row, because
        // ON CONFLICT DO NOTHING is never used.
        //
        // `.select()` is what makes the outcome observable — without it PostgREST
        // returns a null body, and a saved row is indistinguishable from a
        // dropped one. That missing response is how a lead went missing before.
        const { data: upsertData, error: upsertError, count: upsertCount, status: upsertStatus } =
          await serviceClient
            .from("leads")
            .upsert(rowsToSave, {
              onConflict: "user_id,linkedin_url",
              ignoreDuplicates: false,
              count: "exact",
            })
            .select("*");

        console.log("📥 UPSERT RESPONSE:", {
          status: upsertStatus,
          count: upsertCount,
          rowsReturned: upsertData?.length ?? 0,
          error: upsertError
            ? { code: upsertError.code, message: upsertError.message, details: upsertError.details }
            : null,
          data: upsertData,
        });

        if (upsertError) {
          // Nothing is swallowed here. The one expected failure is 21000 from a
          // duplicate conflict key inside the batch, which the dedupe above
          // prevents; anything else is a real problem the caller must see.
          console.error("🚨 Upsert failed:", upsertError);
          return new Response(JSON.stringify({ success: false, error: upsertError.message }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400,
          });
        }

        // Report what the database confirmed, never the size of the array we
        // sent — reporting our own array length is what made a lost row look
        // like a successful save.
        savedCount = upsertData?.length ?? 0;
        console.log(
          `✅ Saved ${savedCount} lead(s) (inserted or updated) out of ${rows.length} scraped profile(s).`,
        );

        // 8e. Mirror into contacts so Lead Search rows also appear on the
        //     Contacts page under the "lead search" contact type.
        const { error: mirrorError } = await upsertContactMirrors(
          serviceClient,
          rowsToSave.map(leadToContactRow)
        );
        if (mirrorError) console.error("❌ Contact mirror upsert error:", mirrorError);
      } else {
        console.log("⚠️ No profiles with a LinkedIn URL to persist.");
      }

      // 9. Send the result + new-lead count back to the React frontend.
      //     The frontend re-fetches from the DB so it always reflects storage.
      return new Response(
        JSON.stringify({
          success: true,
          savedCount,
          found: profiles.length,
          data: cleanedArray,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (error: any) {
      console.error("❌ Error:", error?.message);
      const status = error instanceof HttpError ? error.status : 400;
      return new Response(JSON.stringify({ success: false, error: error?.message || "Search failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status,
      });
    }
  }),
};