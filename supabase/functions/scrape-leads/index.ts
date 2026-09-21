import { withSupabase } from "@supabase/server";
import { createClient } from "npm:@supabase/supabase-js@2";

console.log("🔑 env check:", { url: !!Deno.env.get("SUPABASE_URL"), key: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") });

// Best-effort JWT payload reader (NOT signature verification — that is done by
// Supabase at the gateway). Only an `authenticated` token's `sub` is a real user id.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const section = token.split(".")[1] ?? "";
    const b64 = section.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

function getUserId(req: Request): string | null {
  const authz = req.headers.get("authorization") ?? "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : authz;
  const payload = decodeJwtPayload(token);
  if (payload && payload.role === "authenticated" && typeof payload.sub === "string") {
    return payload.sub;
  }
  return null;
}

function extractEmailFromAbout(text: string): string {
  if (!text) return "";
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : "";
}

function extractPhoneFromAbout(text: string): string {
  if (!text) return "";
  const match = text.match(/\+?[\d\s().-]{7,}/);
  return match ? match[0].trim() : "";
}

function extractFullName(profile: any): string {
  return (
    profile.fullName ||
    profile.name ||
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
    ""
  );
}

function extractCompany(profile: any): string {
  return profile.companyName || profile.company || profile.currentCompany || "";
}

function extractDesignation(profile: any): string {
  return profile.headline || profile.occupation || profile.title || profile.position || "";
}

function extractRole(profile: any): string {
  return profile.role || extractDesignation(profile);
}

function stripToNull(value: any): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function toLeadRow(profile: any, userId: string | null, searchQuery: string) {
  return {
    user_id: userId,
    email: stripToNull(profile.email || profile.emails?.[0] || extractEmailFromAbout(profile.about)),
    phone: stripToNull(extractPhoneFromAbout(profile.about)),
    linkedin_url: stripToNull(profile.profileUrl || profile.url || profile.linkedinUrl),
    full_name: stripToNull(extractFullName(profile)),
    company_name: stripToNull(extractCompany(profile)),
    designation: stripToNull(extractDesignation(profile)),
    role: stripToNull(extractRole(profile)),
    headline: stripToNull(extractDesignation(profile)),
    location: stripToNull(profile.location?.linkedinText || profile.location),
    source_query: searchQuery,
  };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req) => {
    // CORS headers so your React app can call this function
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    try {
      // 1. Get the filters from the React form
      const body = (await req.json()) ?? {};
      const filters = body.filters ?? {};
      console.log("✅ Filters received:", filters);

      // 2. Read secrets from Supabase
      const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");
      const ACTOR_ID = Deno.env.get("APIFY_ACTOR_ID");

      // 3. Combine the selected designation + industry + role into the search query
      const searchQuery = [filters.designation, filters.industry, filters.role]
        .filter(Boolean)
        .join(" ") || "CEO";

      // 4. Build the input in the EXACT format this Actor expects
      const apifyInput = {
        profileScraperMode: "Full",
        searchQuery,
        maxItems: Number(filters.maxItems ?? filters.numProfiles) || 5,
        locations: filters.geography ? [filters.geography] : [],
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

      // 6. Profiles returned by the actor
      const profiles = Array.isArray(data) ? data : (data.data ?? []);

      // 7. Cleaned shape for the frontend (kept for compatibility).
      const cleanedArray = profiles
        .filter((profile: any) => !!(profile.profileUrl || profile.url || profile.linkedinUrl))
        .map((profile: any) => ({
          email: profile.email || profile.emails?.[0] || extractEmailFromAbout(profile.about) || "",
          phone: extractPhoneFromAbout(profile.about) || "",
          linkedinUrl: profile.profileUrl || profile.url || profile.linkedinUrl || "",
          full_name: extractFullName(profile),
          company_name: extractCompany(profile),
          designation: extractDesignation(profile),
          role: extractRole(profile),
        }));

      // 8. Rows to persist. user_id = authenticated user when a JWT is present,
      //     otherwise NULL (public app, no login required).
      const userId = getUserId(req);
      const rows = profiles
        .map((profile: any) => toLeadRow(profile, userId, searchQuery))
        .filter((row: any) => row.linkedin_url);

      let savedCount = 0;
      if (rows.length > 0) {
        const serviceClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        // 8a. Count only rows not already in the DB ("new leads saved").
        const { data: existing } = await serviceClient
          .from("leads")
          .select("linkedin_url")
          .in("linkedin_url", rows.map((row: any) => row.linkedin_url));
        const existingSet = new Set((existing ?? []).map((row: any) => row.linkedin_url));
        savedCount = rows.filter((row: any) => !existingSet.has(row.linkedin_url)).length;

        // 8b. Persist. Requires a unique index/constraint on linkedin_url
        //     (UPSERT target) — see migrations.
        const { error: upsertError } = await serviceClient
          .from("leads")
          .upsert(rows, { onConflict: "linkedin_url", ignoreDuplicates: false });

        if (upsertError) {
          console.error("❌ Upsert error:", upsertError);
          return new Response(JSON.stringify({ success: false, error: upsertError.message }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400,
          });
        }
        console.log("✅ Upserted leads. New rows:", savedCount, "/", rows.length);
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
    } catch (error) {
      console.error("❌ Error:", error.message);
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
  }),
};