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
    name: stripToNull(extractFullName(profile)),
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

function matchesName(profile: any, targetName: string): boolean {
  if (!targetName || !String(targetName).trim()) return true;
  const target = String(targetName).trim().toLowerCase();
  const fullName = extractFullName(profile).trim().toLowerCase();
  if (!fullName) return false;

  // Direct substring check
  if (fullName.includes(target)) return true;

  // Split tokens (e.g. "Rajiv Sharma" -> ["rajiv", "sharma"])
  const tokens = target.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => fullName.includes(token))) {
    return true;
  }

  // Check first / last name
  const first = String(profile.firstName || "").trim().toLowerCase();
  const last = String(profile.lastName || "").trim().toLowerCase();
  const combined = `${first} ${last}`.trim();
  if (combined && (combined.includes(target) || (tokens.length > 0 && tokens.every((t) => combined.includes(t))))) {
    return true;
  }

  return false;
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

    const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");
    if (!APIFY_TOKEN) {
      console.error("Missing required env var: APIFY_TOKEN");
      return new Response(JSON.stringify({ error: "APIFY_TOKEN_MISSING" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ACTOR_ID = Deno.env.get("APIFY_ACTOR_ID");
    if (!ACTOR_ID) {
      console.error("Missing required env var: APIFY_ACTOR_ID");
      return new Response(JSON.stringify({ error: "APIFY_ACTOR_ID_MISSING" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

      const name = String(filters.name || filters.fullName || '').trim();
      const company = String(filters.company || '').trim();
      const industry = String(filters.industry || '').trim();
      const designation = String(filters.designation || '').trim();
      const role = String(filters.role || '').trim();
      const geography = String(filters.geography || '').trim();
      const state = String(filters.state || '').trim();
      const maxRequested = Number(filters.maxItems ?? filters.maxResults ?? filters.numProfiles ?? 5) || 5;

      const COUNTRY_MAP: Record<string, string> = {
        'USA': 'United States',
        'US': 'United States',
        'UK': 'United Kingdom',
        'IN': 'India',
        'CA': 'Canada',
        'AU': 'Australia',
      };
      const normGeo = geography ? (COUNTRY_MAP[geography.toUpperCase()] || geography) : '';
      const normState = state || '';

      const tier1Query = [name, designation, industry].filter(Boolean).join(' ').trim() || (company || 'CEO');
      const tier1Locations = [normGeo, normState].filter(Boolean);
      const tier1Companies = company ? [company] : [];

      const tiers = [
        {
          tier: 1,
          name: 'Tier 1',
          description: 'Tier 1 — Full query with all filters',
          shortDescription: 'Full query with all filters',
          payload: {
            searchQuery: tier1Query,
            locations: tier1Locations,
            ...(tier1Companies.length > 0 ? { currentCompanies: tier1Companies } : {}),
            maxItems: maxRequested,
            profileScraperMode: 'Full',
          },
        },
      ];

      if (tier1Companies.length > 0) {
        tiers.push({
          tier: 2,
          name: 'Tier 2',
          description: 'Tier 2 — Company filter removed',
          shortDescription: 'Company filter removed',
          payload: {
            searchQuery: tier1Query,
            locations: tier1Locations,
            maxItems: maxRequested,
            profileScraperMode: 'Full',
          },
        });
      }

      if (name) {
        tiers.push({
          tier: 3,
          name: 'Tier 3',
          description: 'Tier 3 — Name only with Geography',
          shortDescription: 'Name only with Geography',
          payload: {
            searchQuery: name,
            locations: normGeo ? [normGeo] : [],
            maxItems: maxRequested,
            profileScraperMode: 'Full',
          },
        });
      }

      if (!name && company) {
        tiers.push({
          tier: 4,
          name: 'Tier 4',
          description: 'Tier 4 — Company only with Geography',
          shortDescription: 'Company only with Geography',
          payload: {
            searchQuery: company,
            locations: normGeo ? [normGeo] : [],
            maxItems: maxRequested,
            profileScraperMode: 'Full',
          },
        });
      }

      let winningTier: any = null;
      let winningProfiles: any[] = [];
      const tierAttempts: any[] = [];
      let lastApifyError: string | null = null;

      for (const t of tiers) {
        console.log(`📤 [Apify] Running ${t.description}:`, JSON.stringify(t.payload, null, 2));

        let rawItems: any[] = [];
        let status = 'UNKNOWN';
        let statusMessage: string | null = null;

        try {
          const response = await fetch(
            `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(t.payload),
            }
          );

          if (!response.ok) {
            const errBody = await response.text();
            console.error(`❌ Apify ${response.status}:`, errBody);
            status = `FAILED (${response.status})`;
            statusMessage = errBody;
            lastApifyError = errBody;
          } else {
            status = 'SUCCEEDED';
            const data = await response.json();
            rawItems = Array.isArray(data) ? data : (data.data ?? []);
          }
        } catch (fetchErr: any) {
          status = 'ERROR';
          statusMessage = fetchErr.message;
          lastApifyError = fetchErr.message;
        }

        // Post-filter results by name
        let matchedItems = rawItems;
        if (name) {
          const target = name.toLowerCase().trim();
          matchedItems = rawItems.filter((item: any) => {
            const fn = extractFullName(item).toLowerCase().trim();
            const n = String(item.name || '').toLowerCase().trim();
            return fn.includes(target) || n.includes(target);
          });
        }

        tierAttempts.push({
          tier: t.tier,
          name: t.name,
          description: t.description,
          payload: t.payload,
          status,
          statusMessage,
          rawItemsCount: rawItems.length,
          matchedItemsCount: matchedItems.length,
          rawItemsSample: rawItems.slice(0, 3),
        });

        if (matchedItems.length > 0) {
          winningTier = t;
          winningProfiles = matchedItems;
          console.log(`✅ [Apify] ${t.description} SUCCEEDED with ${matchedItems.length} matching leads!`);
          break;
        } else {
          console.log(`⚠️ [Apify] ${t.description} yielded 0 matching leads. Trying next tier...`);
        }
      }

      // Tier 5: If all tiers return 0, do NOT fabricate results. Return raw Apify request & response JSON.
      if (!winningTier || winningProfiles.length === 0) {
        const isLimit = lastApifyError && /limit|credit|quota|reach|exceed/i.test(lastApifyError);
        const friendlyError = lastApifyError
          ? (isLimit ? `Apify run limit reached: ${lastApifyError}` : `Apify error: ${lastApifyError}`)
          : null;

        return new Response(
          JSON.stringify({
            success: true,
            found: 0,
            savedCount: 0,
            tier: null,
            tierDescription: friendlyError || 'All tiers returned 0 matching profiles',
            tierAttempts,
            leads: [],
            data: [],
            apifyError: friendlyError,
            message: friendlyError || 'All search tiers returned 0 matching profiles.',
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const profiles = winningProfiles;

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
        .map((profile: any) => toLeadRow(profile, userId, winningTier?.payload?.searchQuery || '', filters.industry, filters.role))
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

      const tierDescription = `Found ${profiles.length} lead${profiles.length === 1 ? '' : 's'} on ${winningTier.name} — ${winningTier.shortDescription}`;

      // 9. Send the result + new-lead count back to the React frontend.
      //     The frontend re-fetches from the DB so it always reflects storage.
      return new Response(
        JSON.stringify({
          success: true,
          savedCount,
          found: profiles.length,
          tier: winningTier.tier,
          tierDescription,
          tierAttempts,
          data: cleanedArray,
          leads: cleanedArray,
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