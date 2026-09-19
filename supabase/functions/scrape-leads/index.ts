import { withSupabase } from "@supabase/server";
import { createClient } from "npm:@supabase/supabase-js@2";

console.log("🔑 env check:", { url: !!Deno.env.get("SUPABASE_URL"), key: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") });

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
        maxItems: Number(filters.maxItems) || 5,
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

      const data = await response.json();
      console.log("📥 Apify response:", data);

      // 6. Map each profile down to only the fields the frontend table shows.
      //    Only the person's LinkedIn URL is kept — company URLs are ignored.
      const profiles = Array.isArray(data) ? data : (data.data ?? []);
      const cleanedArray = profiles.map((profile: any) => ({
        email: profile.emails?.[0] || extractEmailFromAbout(profile.about) || "",
        phone: extractPhoneFromAbout(profile.about) || "",
        linkedinUrl: profile.linkedinUrl || "",
        full_name: extractFullName(profile),
        company_name: extractCompany(profile),
        designation: extractDesignation(profile),
        role: extractRole(profile),
      }));

      // 7a. Public endpoint — no JWT. Rows are written without a user id.
      const userId = null;

      // 7b. Persist results to public.leads (service role bypasses RLS).
      //     The upsert runs even when no user id is resolved (public app).
const rows = profiles
          .filter((profile: any) => profile.linkedinUrl)
          .map((profile: any) => ({
            user_id: userId ?? null,
            email: profile.emails?.[0] || extractEmailFromAbout(profile.about) || "",
            phone: extractPhoneFromAbout(profile.about) || "",
            linkedin_url: profile.linkedinUrl || "",
            full_name: extractFullName(profile) || null,
            company_name: extractCompany(profile) || null,
            designation: extractDesignation(profile) || null,
            role: extractRole(profile) || null,
            headline: extractDesignation(profile) || null,
            location: profile.location?.linkedinText || null,
            source_query: searchQuery,
          }));

      console.log("📝 rows to upsert:", rows.length);
      if (rows.length > 0) {
        const serviceClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );
        const { data: upserted, error: upsertError } = await serviceClient
          .from("leads")
          .upsert(rows, { onConflict: "linkedin_url", ignoreDuplicates: false })
          .select();
        if (upsertError) {
          console.error("❌ Upsert error:", upsertError);
        } else {
          console.log("✅ Upserted rows:", upserted?.length ?? 0);
        }
      }

      // 8. Send the cleaned results back to the React frontend
      return new Response(JSON.stringify({ success: true, data: cleanedArray }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("❌ Error:", error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
  }),
};