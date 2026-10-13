import { withSupabase } from "jsr:@supabase/server@^1";
import { createClient } from "npm:@supabase/supabase-js@2";

function extractEmail(item: any): string {
  const candidates = [
    item.email,
    item.work_email,
    item.personal_email,
    Array.isArray(item.emails) ? item.emails[0] : item.emails,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("@")) return c.trim();
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
    const EMAIL_ACTOR = Deno.env.get("APIFY_EMAIL_ACTOR_ID") || "bfH8Ermocz8oYKQVO";

    if (!APIFY_TOKEN || !EMAIL_ACTOR) {
      console.error("Missing APIFY_TOKEN or APIFY_EMAIL_ACTOR_ID in Supabase Secrets");
      return respond({
        success: false,
        found: false,
        reason: "Server config error: missing Apify credentials (check APIFY_TOKEN and APIFY_EMAIL_ACTOR_ID in Supabase Secrets)",
        runUrl: "https://console.apify.com/actors/bfH8Ermocz8oYKQVO/runs",
      });
    }

    const cleanActor = EMAIL_ACTOR.trim().replace('/', '~');
    let runId = "";
    let runUrl = `https://console.apify.com/actors/${cleanActor}/runs`;

    try {
      // Actor input: { urls: ["https://www.linkedin.com/in/..."] }
      const apifyInput = { urls: [linkedinUrl] };
      console.log("Calling email actor", cleanActor, "input:", JSON.stringify(apifyInput));

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

      console.log(`Apify email run started: ${runId}. Polling status...`);

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

      console.log(`Apify email run ${runId} completed with status: ${currentStatus}`);

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

      // If dataset is empty, check run log to see why 0 items were produced (e.g. Free plan limit reached)
      if (list.length === 0) {
        console.warn(`Apify email run ${runId} yielded 0 items. Inspecting run log...`);
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

        // Extract key warning/limit lines from the Apify log
        const logLines = logText
          .split('\n')
          .filter((l) => /Free plan limit|limit of \d+ requests|15\/15 requests used|Upgrade to a paid|usage limit reached|monthly spend limit/i.test(l))
          .map((l) => l.replace(/.*\[apify\]\s*(?:INFO|WARN|ERROR)\s*/i, '').trim())
          .filter(Boolean);

        const isLimit =
          logLines.length > 0 ||
          /free plan limit|limit of \d+ requests|15\/15 requests used|upgrade to a paid|usage limit reached|monthly spend limit/i.test(logText);

        if (isLimit) {
          const displayMsg =
            logLines.join('\n') ||
            "Free plan: 15/15 requests used, 0 remaining\nFree plan limit of 15 requests reached. Upgrade to a paid Apify plan to continue.";

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

        // Run succeeded but returned no items (no email found)
        const serviceClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );
        await serviceClient.from("leads").update({ email_attempted: true }).eq("id", leadId);

        return respond({
          success: true,
          found: false,
          email: "",
          runId,
          runUrl,
          reason: "Actor returned no email for this profile",
        });
      }

      console.log("Apify email raw item:", JSON.stringify(list[0]).slice(0, 600));

      const first = list[0] ?? {};

      // Check if the actor output reported an explicit error / limit
      const rawErr = first.error || (first.message && !first.email ? first.message : null);
      const errStr = typeof rawErr === "object" ? (rawErr.message || JSON.stringify(rawErr)) : (typeof rawErr === "string" ? rawErr : "");
      if (errStr && !/no (?:email|contact)/i.test(errStr)) {
        const isLimit = /free plan limit|limit of \d+|15\/15|upgrade to a paid|usage limit|insufficient credit|quota/i.test(errStr);
        console.warn("Apify email actor reported error/limit:", errStr);
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

      // Extract email using actor's found flag or presence of a valid email field
      const candidateEmail = extractEmail(first);
      const emailFound = (first.found === true || (first.found !== false && Boolean(candidateEmail))) && Boolean(candidateEmail);
      const email      = emailFound ? candidateEmail : "";

      console.log("found flag:", first.found, "| email:", email || "(none)");

      // Only write email when the actor confirmed it found one.
      const updatePayload: Record<string, any> = { email_attempted: true };
      if (email) updatePayload.email = email;
      if (first.name && typeof first.name === "string" && first.name.trim().length > 0) {
        updatePayload.name = first.name.trim();
        updatePayload.full_name = first.name.trim();
      }

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
        return respond({ success: false, found: emailFound, reason: updateError.message, email, runId, runUrl });
      }

      console.log("Saved lead", leadId, "email:", email || "(none)");

      if (email) {
        // Mirror into contacts — best-effort update (only if contact already exists).
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
        full_name:    first.name    || "",
        company_name: first.company || "",
        designation:  "",
        runId,
        runUrl,
      });

    } catch (err: any) {
      console.error("Unhandled error:", err?.message);
      return respond({
        success: false,
        found: false,
        reason: err?.message || "Enrichment failed",
        runId,
        runUrl,
      });
    }
  }),
};
