import { withSupabase } from "jsr:@supabase/server@^1";
import { createClient } from "npm:@supabase/supabase-js@2";

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
      // Actor "Find Mobile Phones of Decision Makers". Plain ID, so no "~" encoding needed.
      const APIFY_PHONE_ACTOR_ID = Deno.env.get("APIFY_PHONE_ACTOR_ID") || "J9mf98b4CIZpW72Ue";

      console.log("📞 Calling Apify actor", APIFY_PHONE_ACTOR_ID, "for", linkedinUrl);

      // 3. Call the actor with its expected input key: { profileUrl }
      const res = await fetch(
        `https://api.apify.com/v2/acts/${APIFY_PHONE_ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileUrl: linkedinUrl }),
        }
      );

      if (!res.ok) {
        const errBody = await res.text();
        console.error(`❌ Apify ${res.status}:`, errBody);
        throw new Error(`Apify call failed (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      console.log("📥 Apify response:", JSON.stringify(data).slice(0, 500));

      // 4. Parse the first result and pull the phone number
      const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [data];
      const first = list[0] ?? {};
      const phone = extractPhone(first);
      console.log("📞 phone found:", phone);

      if (!phone) {
        const message = String(first?.message || "");
        const noMobile =
          first?.success === false ||
          /not found/i.test(message) ||
          /no mobile/i.test(message);
        return new Response(
          JSON.stringify({
            success: false,
            error: noMobile
              ? "No mobile number found for this profile"
              : "No phone number returned from Apify",
          }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 5. Write the phone back to public.leads (service role bypasses RLS)
      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      const { error: updateError } = await serviceClient
        .from("leads")
        .update({ phone })
        .eq("id", leadId);
      if (updateError) {
        console.error("❌ Update error:", updateError);
        return new Response(
          JSON.stringify({ success: false, error: updateError.message }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log("✅ Updated lead", leadId, "phone =", phone);

      // 6. Send the phone back to the React frontend
      return new Response(
        JSON.stringify({ success: true, found: true, phone }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (error: any) {
      console.error("❌ Error:", error.message);
      return new Response(
        JSON.stringify({ success: false, error: error.message || "Phone lookup failed" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }),
};