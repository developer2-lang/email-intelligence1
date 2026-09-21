import { withSupabase } from "jsr:@supabase/server@^1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { leadToContactRow, upsertContactMirrors } from "../_shared/contactMirror.ts";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function fail(message: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function pick(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  }
  return "";
}

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

function extractFullName(item: any): string {
  return pick(
    [item.firstName, item.lastName].filter(Boolean).join(" "),
    item.fullName,
    item.name,
    item.name_text,
  );
}

async function fetchProfile(url: string): Promise<any> {
  const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");
  const APIFY_STAGE2_ACTOR_ID = Deno.env.get("APIFY_STAGE2_ACTOR_ID");
  if (!APIFY_TOKEN || !APIFY_STAGE2_ACTOR_ID) {
    throw new Error("Missing APIFY secrets");
  }
  const apiUrl = `https://api.apify.com/v2/acts/${APIFY_STAGE2_ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  console.log("[add-lead-manual] calling Stage 2 Apify actor:", url);

  // Same input shapes enrich-lead tries, in order of likelihood.
  const inputAttempts = [
    { urls: [url] },
    { linkedin_url: url },
    { linkedinUrls: [url] },
    { profileUrls: [url] },
  ];

  let data: any = null;
  let succeeded = false;
  for (const attempt of inputAttempts) {
    console.log("[add-lead-manual] trying Apify input:", JSON.stringify(attempt));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt),
        signal: controller.signal,
      });
      if (res.ok) {
        data = await res.json();
        succeeded = true;
        console.log("[add-lead-manual] Apify succeeded with input:", JSON.stringify(attempt));
        break;
      }
      console.error("[add-lead-manual] Apify response:", res.status, await res.text());
    } catch (e: any) {
      console.error("[add-lead-manual] Apify fetch error:", e?.message || e);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  if (!succeeded) {
    throw new Error("Apify profile lookup failed — timed out or errored on all attempts");
  }

  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [data];
  return list[0] ?? {};
}

export default {
  fetch: withSupabase({ auth: ["user", "publishable", "secret"] }, async (req) => {
    console.log("[add-lead-manual] received:", req.method, req.url);
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

    try {
      const body = (await req.json()) ?? {};
      const action = body.action;

      // ── Fetch: look up a LinkedIn URL and return profile fields (no DB write)
      if (action === "fetch") {
        const url = clean(body.linkedinUrl);
        if (!url) return fail("linkedinUrl is required");

        const item = await fetchProfile(url);
        const profile = {
          linkedinUrl: url,
          full_name: extractFullName(item),
          company_name: pick(item.company, item.companyName, item.currentCompany, item.company_name),
          job_title: pick(
            item.jobTitle,
            item.job_title,
            item.position,
            item.currentPosition?.[0]?.position,
            item.experience?.[0]?.title,
          ),
          designation: pick(item.designation, item.headline, item.occupation, item.title, item.position),
          role: pick(item.role, item.headline, item.position),
          industry: pick(item.industry, item.industryName, item.sector),
          geography: pick(
            item.geography,
            item.location?.linkedinText,
            item.location?.parsed?.country,
            item.location,
            item.country,
            item.address,
          ),
          email: extractEmail(item),
          phone: extractPhone(item),
        };
        return ok({ success: true, profile });
      }

      // ── Save: upsert a full row on linkedin_url and return the saved row
      if (action === "save") {
        const url = clean(body.linkedinUrl ?? body.url);
        if (!url) return fail("linkedinUrl is required");

        const f = body.fields ?? {};
        const row: Record<string, any> = {
          linkedin_url: url,
          full_name: clean(f.full_name) ?? null,
          company_name: clean(f.company_name) ?? null,
          job_title: clean(f.job_title) ?? null,
          designation: clean(f.designation) ?? null,
          role: clean(f.role) ?? null,
          industry: clean(f.industry) ?? null,
          geography: clean(f.geography) ?? null,
          email: clean(f.email) ?? null,
          phone: clean(f.phone) ?? null,
        };

        const urlEnv = Deno.env.get("SUPABASE_URL");
        const keyEnv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (!urlEnv || !keyEnv) throw new Error("Missing Supabase credentials");

        const serviceClient = createClient(urlEnv, keyEnv);
        const { error: upsertError } = await serviceClient
          .from("leads")
          .upsert(row, { onConflict: "linkedin_url" });
        if (upsertError) return fail(upsertError.message);

        // Mirror the same row into contacts ("lead search" contact type).
        const { error: mirrorError } = await upsertContactMirrors(serviceClient, [leadToContactRow(row)]);
        if (mirrorError) console.error("[add-lead-manual] contact mirror error:", mirrorError?.message);

        const { data: saved } = await serviceClient
          .from("leads")
          .select("id, linkedin_url, full_name, company_name, job_title, designation, role, industry, geography, email, phone, created_at")
          .eq("linkedin_url", url)
          .maybeSingle();
        return ok({ success: true, data: saved ?? row });
      }

      return fail(`Unknown action: ${action}`);
    } catch (error: any) {
      console.error("[add-lead-manual] handler error:", error?.message, error?.stack);
      return fail(error?.message || "add-lead-manual failed");
    }
  }),
};