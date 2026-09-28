import { withSupabase } from "jsr:@supabase/server@^1";
import { createClient } from "npm:@supabase/supabase-js@2";

// Email actor (APIFY_EMAIL_ACTOR_ID = bfH8Ermocz8oYKQVO) response shape:
// [{ linkedin_url, found: true, email: "amit@airpay.co.in", name: "Amit Bavdhankar",
//    domain: "airpay.co.in", company: "Airpay Payment Services" }]

export default {
  fetch: withSupabase({ auth: ["user", "publishable", "secret"] }, async (req) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    // Always HTTP 200 so the frontend can read the JSON body.
    const respond = (body: object) =>
      new Response(JSON.stringify(body), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const { leadId, linkedinUrl } = await req.json().catch(() => ({}));
    if (!leadId || !linkedinUrl) {
      return respond({ success: false, found: false, reason: "leadId and linkedinUrl are required" });
    }

    try {
      const APIFY_TOKEN   = Deno.env.get("APIFY_TOKEN");
      const EMAIL_ACTOR   = Deno.env.get("APIFY_EMAIL_ACTOR_ID"); // bfH8Ermocz8oYKQVO

      if (!APIFY_TOKEN || !EMAIL_ACTOR) {
        console.error("Missing APIFY_TOKEN or APIFY_EMAIL_ACTOR_ID");
        return respond({ success: false, found: false, reason: "Server config error: missing Apify credentials" });
      }

      // Actor input: { urls: ["https://www.linkedin.com/in/..."] }
      // Confirmed working from live logs:
      //   "Working input schema: {"urls":["https://www.linkedin.com/in/mohantysanjib"]}"
      const apifyInput = { urls: [linkedinUrl] };
      console.log("Calling email actor", EMAIL_ACTOR, "input:", JSON.stringify(apifyInput));

      const res = await fetch(
        `https://api.apify.com/v2/acts/${EMAIL_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
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
      console.log("Apify email raw:", JSON.stringify(data).slice(0, 600));

      // Response: [{ linkedin_url, found, email, name, domain, company }]
      const list  = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : [data]);
      const first = list[0] ?? {};

      // Use the actor's own "found" field — it sets it explicitly to true/false.
      const emailFound = first.found === true && typeof first.email === "string" && first.email.trim().length > 0;
      const email      = emailFound ? first.email.trim() : "";

      console.log("found flag:", first.found, "| email:", email || "(none)");

      // Only write email when the actor confirmed it found one.
      // Never null-out a value a previous enrichment already wrote.
      const updatePayload: Record<string, any> = { email_attempted: true };
      if (email) updatePayload.email = email;

      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      // UPDATE by primary key — no ON CONFLICT, no 42P10.
      const { error: updateError } = await serviceClient
        .from("leads")
        .update(updatePayload)
        .eq("id", leadId);

      if (updateError) {
        console.error("DB update error:", updateError);
        return respond({ success: false, found: emailFound, reason: updateError.message, email });
      }

      console.log("Saved lead", leadId, "email:", email || "(none)");

      if (email) {
        // Mirror into contacts — best-effort update (only if contact already exists).
        // Using upsert would fail if the contact doesn't exist yet because user_id is NOT NULL.
        const { error: mirrorError } = await serviceClient
          .from("contacts")
          .update({ email })
          .eq("linkedin_url", linkedinUrl);
        if (mirrorError) console.error("Contact mirror error:", mirrorError);
      }

      return respond({
        success: true,
        found: emailFound,
        reason: emailFound ? "" : "Actor returned no email for this profile",
        email,
        // Pass through profile data for UI display
        full_name:    first.name    || "",
        company_name: first.company || "",
        designation:  "",
      });

    } catch (err: any) {
      console.error("Unhandled error:", err?.message);
      return respond({ success: false, found: false, reason: err?.message || "Enrichment failed" });
    }
  }),
};
