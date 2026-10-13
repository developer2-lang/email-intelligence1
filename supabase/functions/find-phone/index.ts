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

    // Read Apify credentials purely from Supabase Secrets
    const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN") || Deno.env.get("APIFY_API_TOKEN");
    const PHONE_ACTOR =
      Deno.env.get("APIFY_Phone_ACTOR_ID") ||
      Deno.env.get("APIFY_PHONE_ACTOR_ID") ||
      Deno.env.get("APIFY_STAGE2_ACTOR_ID") ||
      "J9mf98b4CIZpW72Ue";

    if (!APIFY_TOKEN || !PHONE_ACTOR) {
      console.error("Missing APIFY_TOKEN or APIFY_Phone_ACTOR_ID in Supabase Secrets");
      return respond({
        success: false,
        found: false,
        reason: "Server config error: missing Apify credentials (check APIFY_TOKEN and APIFY_Phone_ACTOR_ID in Supabase Secrets)",
        runUrl: "https://console.apify.com/actors/J9mf98b4CIZpW72Ue/runs",
      });
    }

    const cleanActor = PHONE_ACTOR.trim().replace('/', '~');
    let runId = "";
    let runUrl = `https://console.apify.com/actors/${cleanActor}/runs`;

    try {
      // Actor input: { linkedinUrl: "https://www.linkedin.com/in/..." }
      const apifyInput = { linkedinUrl: linkedinUrl };
      console.log("Calling phone actor", cleanActor, "input:", JSON.stringify(apifyInput));

      // Start run (fast POST, returns in <500ms with run ID) to prevent 502 Gateway Timeouts
      const startRes = await fetch(
        `https://api.apify.com/v2/acts/${cleanActor}/runs?token=${APIFY_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(apifyInput),
        }
      );

      if (!startRes.ok) {
        const errBody = await startRes.text();
        console.error(`Apify start error ${startRes.status}:`, errBody);
        let parsedMessage = errBody;
        try {
          const parsed = JSON.parse(errBody);
          parsedMessage = parsed.error?.message || parsed.message || parsed.error || errBody;
        } catch {}
        const isLimit =
          startRes.status === 429 ||
          startRes.status === 402 ||
          /free plan limit|limit of \d+|15\/15|upgrade to a paid|usage limit|insufficient credit|quota/i.test(parsedMessage);

        return respond({
          success: false,
          found: false,
          isLimit,
          apifyError: parsedMessage,
          reason: isLimit ? `Apify limit reached: ${parsedMessage}` : `Apify error: ${parsedMessage}`,
          runUrl: `https://console.apify.com/actors/${cleanActor}/runs`,
        });
      }

      const runStartJson = await startRes.json();
      const run = runStartJson?.data || runStartJson;
      runId = run?.id || "";
      const defaultDatasetId = run?.defaultDatasetId;
      if (runId) {
        runUrl = `https://console.apify.com/view/runs/${runId}#/log`;
      }

      console.log(`Apify phone run started: ${runId}. Polling status...`);

      // Poll status every 2 seconds until finished or timeout
      let currentStatus = run?.status || "RUNNING";
      const pollStart = Date.now();
      const maxWaitMs = 50_000;

      while (["READY", "RUNNING"].includes(currentStatus) && Date.now() - pollStart < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          const statusRes = await fetch(
            `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
          );
          if (statusRes.ok) {
            const statusJson = await statusRes.json();
            currentStatus = statusJson?.data?.status || currentStatus;
          }
        } catch (e) {
          console.warn("Poll status check error:", e);
        }
      }

      console.log(`Apify phone run ${runId} completed with status: ${currentStatus}`);

      let list: any[] = [];
      if (defaultDatasetId) {
        const dsRes = await fetch(
          `https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${APIFY_TOKEN}`
        );
        if (dsRes.ok) {
          const dsData = await dsRes.json();
          list = Array.isArray(dsData) ? dsData : (Array.isArray(dsData?.data) ? dsData.data : []);
        }
      }

      // If dataset is empty, inspect run log
      if (list.length === 0) {
        console.warn(`Apify phone run ${runId} yielded 0 items. Inspecting run log...`);
        let logText = "";

        if (runId) {
          try {
            const logRes = await fetch(
              `https://api.apify.com/v2/actor-runs/${runId}/log?token=${APIFY_TOKEN}`
            );
            if (logRes.ok) {
              logText = await logRes.text();
            }
          } catch (logErr) {
            console.error("Failed to read run log:", logErr);
          }
        }

        const logLines = logText
          .split('\n')
          .filter((l) => /Free plan limit|limit of \d+ requests|15\/15 requests used|Upgrade to a paid|usage limit reached|monthly spend limit/i.test(l))
          .map((l) => l.replace(/.*\[apify\]\s*(?:INFO|WARN|ERROR)\s*/i, '').trim())
          .filter(Boolean);

        const isLimit =
          logLines.length > 0 ||
          /free plan limit|limit of \d+ requests|15\/15 requests used|upgrade to a paid|usage limit reached|monthly spend limit/i.test(logText);

        if (isLimit) {
          const displayMsg = logLines.join('\n') || "Apify plan limit reached. Upgrade to continue.";
          return respond({
            success: false,
            found: false,
            isLimit: true,
            apifyError: displayMsg,
            rawLog: logText.slice(-1000),
            runId,
            runUrl,
            reason: `Apify limit reached: ${displayMsg}`,
          });
        }

        // Check if the run simply found no phone number
        const serviceClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );
        await serviceClient.from("leads").update({ phone_attempted: true }).eq("id", leadId);

        return respond({
          success: true,
          found: false,
          phone: "",
          runId,
          runUrl,
          reason: "No phone number found for this profile",
        });
      }

      console.log("Apify phone raw item:", JSON.stringify(list[0]).slice(0, 500));

      const first = list[0] ?? {};

      // Check if the actor output reported an explicit error / limit
      const rawErr = first.error || (first.message && !first.mobile_number && !first.phone ? first.message : null);
      const errStr = typeof rawErr === "object" ? (rawErr.message || JSON.stringify(rawErr)) : (typeof rawErr === "string" ? rawErr : "");
      if (errStr && !/no (?:mobile )?phone/i.test(errStr)) {
        const isLimit = /free plan limit|limit of \d+|15\/15|upgrade to a paid|usage limit|insufficient credit|quota/i.test(errStr);
        console.warn("Apify phone actor reported error/limit:", errStr);
        return respond({
          success: false,
          found: false,
          isLimit,
          apifyError: errStr,
          reason: isLimit ? `Apify limit reached: ${errStr}` : `Apify error: ${errStr}`,
          runId,
          runUrl,
        });
      }

      const phone = extractPhone(first); // reads mobile_number first
      console.log("phone found:", phone || "(none)");

      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      if (!phone) {
        // Mark attempted so we know a lookup was run (UI will show Not Found with Retry).
        await serviceClient.from("leads").update({ phone_attempted: true }).eq("id", leadId);
        return respond({ success: true, found: false, reason: "No phone number found for this profile", phone: "", runId, runUrl });
      }

      // Save phone to the leads row.
      const { error: updateError } = await serviceClient
        .from("leads")
        .update({ phone, phone_attempted: true })
        .eq("id", leadId);

      if (updateError) {
        console.error("DB update error:", updateError);
        return respond({ success: false, found: true, reason: updateError.message, phone, runId, runUrl });
      }

      console.log("Saved phone", phone, "for lead", leadId);

      // Mirror into contacts — best-effort update (only if contact already exists).
      const { error: mirrorError } = await serviceClient
        .from("contacts")
        .update({ phone })
        .eq("linkedin_url", linkedinUrl);
      if (mirrorError) console.error("Contact mirror error:", mirrorError);

      return respond({ success: true, found: true, reason: "", phone, runId, runUrl });

    } catch (err: any) {
      console.error("Unhandled error:", err?.message);
      return respond({
        success: false,
        found: false,
        reason: err?.message || "Phone lookup failed",
        runId,
        runUrl,
      });
    }
  }),
};
