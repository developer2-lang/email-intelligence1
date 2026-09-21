import { withSupabase } from "jsr:@supabase/server@^1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { upsertContactMirrors } from "../_shared/contactMirror.ts";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function extractEmail(item: any): string {
  const candidates = [
    item.email,
    item.emailAddress,
    item.workEmail,
    Array.isArray(item.emails) ? item.emails[0] : item.emails,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const text = [item.about, item.summary, item.description]
    .filter((t: any) => typeof t === "string")
    .join(" ");
  const m = text.match(EMAIL_REGEX);
  return m ? m[0] : "";
}

function extractPhone(item: any): string {
  const candidates = [
    item.mobile_number,
    item.phone,
    item.mobile,
    item.mobilePhone,
    item.phoneNumber,
    item.phone_number,
    item.telephone,
    item.contactPhone,
    Array.isArray(item.phoneNumbers) ? item.phoneNumbers[0] : item.phoneNumbers,
    Array.isArray(item.phones) ? item.phones[0] : item.phones,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const nested = [item.data, item.profile, item.contact, item.result];
  for (const n of nested) {
    if (n && typeof n === "object" && !Array.isArray(n)) {
      const deep = extractPhone(n);
      if (deep) return deep;
    }
  }
  return "";
}

export default {
  fetch: withSupabase({ auth: ["user", "publishable", "secret"] }, async (req) => {
    // CORS headers so your React app can call this function
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    try {
      // 1. Read the target row + profile from the React app
      const { leadId, linkedinUrl } = await req.json();
      if (!leadId || !linkedinUrl) {
        return new Response(
          JSON.stringify({ success: false, error: "leadId and linkedinUrl are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 2. Read secrets from Supabase
      const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");
      const APIFY_STAGE2_ACTOR_ID = Deno.env.get("APIFY_STAGE2_ACTOR_ID");

      // 3. Try plausible input schemas until the actor accepts one (200).
      //    vulnv/linkedin-email-finder expects { urls: [...] } — try it FIRST,
      //    then fall back to the other shapes.
      const inputAttempts = [
        { urls: [linkedinUrl] },
        { linkedin_url: linkedinUrl },
        { linkedinUrls: [linkedinUrl] },
        { profileUrls: [linkedinUrl] },
      ];

      let data: any = null;
      let succeeded = false;
      for (const attempt of inputAttempts) {
        console.log("📤 Trying Stage 2 Apify input:", attempt);

        // 4. Call the Stage 2 Apify actor
        const res = await fetch(
          `https://api.apify.com/v2/acts/${APIFY_STAGE2_ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(attempt),
          }
        );

        if (res.ok) {
          data = await res.json();
          succeeded = true;
          console.log("✅ Working input schema:", JSON.stringify(attempt));
          break;
        }

        const errBody = await res.text();
        console.error(`❌ Apify ${res.status}:`, errBody);
      }

      if (!succeeded) {
        throw new Error(
          `Apify call failed with all input attempts: ${JSON.stringify(inputAttempts)}`
        );
      }

      console.log("📥 Stage 2 Apify response:", data);
      console.log("📥 Apify raw:", JSON.stringify(data).slice(0, 500));

      // 5. Parse the first enriched profile
      const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [data];
      const first = list[0] ?? {};
      const email = extractEmail(first);
      const phone = extractPhone(first);
      console.log("🔍 found:", first.found);
      console.log("✉️  email found:", email);
      console.log("📞 phone found:", phone);

      // 6. Stage 2 writes ONLY email + phone back to public.leads. All other
      //    columns (name, company, job_title, designation, geography, role,
      //    industry) are owned by Stage 1 (scrape-leads). UPSERT on
      //    linkedin_url so an existing row keeps its Stage 1 values untouched.
      const designation =
        first.designation || first.headline || first.occupation || first.title || first.position || "";
      const updatePayload: Record<string, any> = { linkedin_url: linkedinUrl, email: email || null };
      if (phone) updatePayload.phone = phone;

      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      const { error: updateError } = await serviceClient
        .from("leads")
        .upsert(updatePayload, { onConflict: "linkedin_url" });
      if (updateError) {
        console.error("❌ Update error:", updateError);
        return new Response(
          JSON.stringify({ success: false, error: updateError.message }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log("✅ Updated lead", leadId);

      // 6b. Mirror email/phone into the matching contacts row (partial update,
      //     only touches the provided columns).
      const { error: mirrorError } = await upsertContactMirrors(serviceClient, [
        { linkedin_url: linkedinUrl, email: email || null, phone: phone || null },
      ]);
      if (mirrorError) console.error("❌ Contact mirror update error:", mirrorError);

      // 7. Send the enriched values back to the React frontend
      return new Response(
        JSON.stringify({
          success: true,
          found: !!first.found,
          email,
          phone,
          full_name: first.name || "",
          company_name: first.company || "",
          designation: designation || "",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (error: any) {
      console.error("❌ Error:", error.message);
      return new Response(
        JSON.stringify({ success: false, error: error.message || "Enrichment failed" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }),
};