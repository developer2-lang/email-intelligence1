import { withSupabase } from "jsr:@supabase/server@^1";
import { createClient } from "npm:@supabase/supabase-js@2";

function extractPhone(item: any): string {
  // mobile_number is the confirmed field name from the actor's live response.
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
    Array.isArray(item.phones)       ? item.phones[0]       : item.phones,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

export default {
  fetch: withSupabase({ auth: ["user", "publishable", "secret"] }, async (req) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    // Always respond HTTP 200 so the frontend can read the JSON body.
    const respond = (body: object) =>
      new Response(JSON.stringify(body), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const { leadId, linkedinUrl } = await req.json().catch(() => ({}));
    if (!leadId || !linkedinUrl) {
      return respond({ success: false, found: false, reason: "leadId and linkedinUrl are required" });
    }

    try {
      const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");
      const ACTOR_ID    = Deno.env.get("APIFY_STAGE2_ACTOR_ID"); // J9mf98b4CIZpW72Ue

      if (!APIFY_TOKEN || !ACTOR_ID) {
        console.error("Missing APIFY_TOKEN or APIFY_STAGE2_ACTOR_ID");
        return respond({ success: false, found: false, reason: "Server config error: missing Apify credentials" });
      }

      // The mobile phone actor (J9mf98b4CIZpW72Ue) expects { "linkedinUrl": "..." }
      // If we pass an invalid schema, it uses its default run input (which is Alex Maccaw's profile!)
      const apifyInput = { linkedinUrl: linkedinUrl };
      console.log("Calling phone actor", ACTOR_ID, "input:", JSON.stringify(apifyInput));

      const res = await fetch(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(apifyInput),
        }
      );

      if (!res.ok) {
        const errBody = await res.text();
        console.error(`Apify ${res.status}:`, errBody);
        return respond({ success: false, found: false, reason: `Apify actor returned ${res.status}` });
      }

      const data = await res.json();
      console.log("Apify raw:", JSON.stringify(data).slice(0, 500));

      // Response: [{ input_url, mobile_number, profile_url, ... }]
      const list  = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : [data]);
      const first = list[0] ?? {};
      const phone = extractPhone(first); // reads mobile_number first
      console.log("phone found:", phone || "(none)");

      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      if (!phone) {
        // Mark attempted so we know a lookup was run (but UI always shows button).
        await serviceClient.from("leads").update({ phone_attempted: true }).eq("id", leadId);
        return respond({ success: true, found: false, reason: "No phone number found for this profile", phone: "" });
      }

      // Save phone to the leads row.
      const { error: updateError } = await serviceClient
        .from("leads")
        .update({ phone, phone_attempted: true })
        .eq("id", leadId);

      if (updateError) {
        console.error("DB update error:", updateError);
        return respond({ success: false, found: true, reason: updateError.message, phone });
      }

      console.log("Saved phone", phone, "for lead", leadId);

      // Mirror into contacts — best-effort update (only if contact already exists).
      const { error: mirrorError } = await serviceClient
        .from("contacts")
        .update({ phone })
        .eq("linkedin_url", linkedinUrl);
      if (mirrorError) console.error("Contact mirror error:", mirrorError);

      return respond({ success: true, found: true, reason: "", phone });

    } catch (err: any) {
      console.error("Unhandled error:", err?.message);
      return respond({ success: false, found: false, reason: err?.message || "Phone lookup failed" });
    }
  }),
};
