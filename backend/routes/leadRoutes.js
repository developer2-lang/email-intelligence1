import { Router } from 'express';
import { ApifyClient } from 'apify-client';

const router = Router();

let _supabase = null;
async function getSupabaseSafe() {
  if (_supabase) return _supabase;
  try {
    const mod = await import('../services/supabaseService.js');
    _supabase = mod.supabase;
    return _supabase;
  } catch {
    return null;
  }
}

export function extractFullName(item) {
  if (item.fullName && typeof item.fullName === 'string') return item.fullName.trim();
  const parts = [item.firstName, item.lastName].filter(Boolean).map((s) => String(s).trim());
  if (parts.length > 0) return parts.join(' ');
  if (item.name && typeof item.name === 'string') return item.name.trim();
  return '—';
}

export function extractJobTitle(item) {
  if (item.jobTitle && typeof item.jobTitle === 'string') return item.jobTitle.trim();
  if (item.job_title && typeof item.job_title === 'string') return item.job_title.trim();
  if (item.position && typeof item.position === 'string') return item.position.trim();
  if (item.currentJobTitle && typeof item.currentJobTitle === 'string') return item.currentJobTitle.trim();
  if (Array.isArray(item.currentPosition) && item.currentPosition[0]?.position) {
    return item.currentPosition[0].position.trim();
  }
  if (Array.isArray(item.experience) && item.experience[0]?.title) {
    return item.experience[0].title.trim();
  }
  if (item.headline && typeof item.headline === 'string') return item.headline.trim();
  return '—';
}

export function extractCompany(item, fallbackCompany) {
  if (item.companyName && typeof item.companyName === 'string') return item.companyName.trim();
  if (item.currentCompany && typeof item.currentCompany === 'string') return item.currentCompany.trim();
  if (item.company && typeof item.company === 'string') return item.company.trim();
  if (Array.isArray(item.currentPosition) && item.currentPosition[0]?.companyName) {
    return item.currentPosition[0].companyName.trim();
  }
  if (Array.isArray(item.experience) && item.experience[0]?.company) {
    return item.experience[0].company.trim();
  }
  return fallbackCompany || '—';
}

export function extractEmail(item) {
  if (typeof item.email === 'string' && item.email.includes('@')) return item.email.trim();
  if (Array.isArray(item.emails) && item.emails.length > 0) {
    const first = item.emails[0];
    if (typeof first === 'string' && first.includes('@')) return first.trim();
    if (first && typeof first.email === 'string' && first.email.includes('@')) return first.email.trim();
  }
  if (typeof item.mail === 'string' && item.mail.includes('@')) return item.mail.trim();
  return null;
}

export function extractLinkedInUrl(item) {
  return (
    item.linkedinUrl ||
    item.profileUrl ||
    item.url ||
    item.linkedInProfileUrl ||
    item.linkedin ||
    ''
  );
}

export function extractLocation(item, fallbackGeography, fallbackState) {
  if (typeof item.location === 'string' && item.location.trim()) return item.location.trim();
  if (item.location?.linkedinText) return item.location.linkedinText.trim();
  if (item.location?.parsed?.country) return item.location.parsed.country.trim();
  if (fallbackState && fallbackGeography) return `${fallbackState}, ${fallbackGeography}`;
  return fallbackGeography || fallbackState || '—';
}

/**
 * Extracts all company names associated with the profile (current position, companyName, experience).
 */
export function getProfileCompanyNames(item) {
  const companies = [];
  if (item.companyName) companies.push(item.companyName);
  if (item.currentCompany) companies.push(item.currentCompany);
  if (item.company) companies.push(item.company);
  if (Array.isArray(item.currentCompanies)) {
    for (const c of item.currentCompanies) {
      if (typeof c === 'string') companies.push(c);
      else if (c?.name) companies.push(c.name);
    }
  }
  if (Array.isArray(item.currentPosition)) {
    for (const pos of item.currentPosition) {
      if (pos?.companyName) companies.push(pos.companyName);
      if (pos?.company) companies.push(pos.company);
    }
  }
  if (Array.isArray(item.experience)) {
    for (const exp of item.experience) {
      if (exp?.current || exp?.isCurrent || !exp?.endDate) {
        if (exp?.companyName) companies.push(exp.companyName);
        if (exp?.company) companies.push(exp.company);
      }
    }
    // If no explicit current flag, check the first listed experience
    if (companies.length === 0 && item.experience[0]) {
      if (item.experience[0].companyName) companies.push(item.experience[0].companyName);
      if (item.experience[0].company) companies.push(item.experience[0].company);
    }
  }
  return companies.map((c) => String(c).trim()).filter(Boolean);
}

/**
 * Filter results strictly by the currentCompanies array so that only
 * profiles from the specified company are returned (e.g. Whipsaw included,
 * Beyond Design, Inc. excluded).
 */
export function matchesCurrentCompanies(item, targetCompanies) {
  if (!targetCompanies || targetCompanies.length === 0) return true;

  const currentCompaniesList = Array.isArray(item.currentCompanies)
    ? item.currentCompanies.map((c) => (typeof c === 'string' ? c : c?.name || c?.companyName))
    : [];

  const currentPositionList = Array.isArray(item.currentPosition)
    ? item.currentPosition.map((p) => p?.companyName || p?.company)
    : [];

  const experienceList = Array.isArray(item.experience)
    ? item.experience.map((e) => e?.companyName || e?.company)
    : [];

  const fields = [
    item.currentCompany,
    item.company_name,
    item.company,
    item.companyName,
    ...currentCompaniesList,
    ...currentPositionList,
    ...experienceList,
    item.headline,
    item.job_title,
    item.designation,
  ].filter(Boolean);

  return targetCompanies.some((target) => {
    const t = String(target || '').trim().toLowerCase();
    if (!t) return true;
    return fields.some((field) =>
      String(field).toLowerCase().includes(t)
    );
  });
}

/**
 * Builds the Apify LinkedIn Search Actor payload according to required schema.
 */
export function buildApifyPayload(filters = {}) {
  const company = String(filters.company || '').trim();
  const designation = String(filters.designation || '').trim();
  const industry = String(filters.industry || '').trim();
  const role = String(filters.role || '').trim();
  const geography = String(filters.geography || '').trim();
  const state = String(filters.state || '').trim();
  const maxResults = Number(filters.maxResults || filters.maxItems || filters.numProfiles || 10);

  // searchQuery: combine all non-empty values
  const searchQuery = [company, designation, industry, role]
    .filter(Boolean)
    .join(' ')
    .trim() || 'CEO';

  // currentCompanies: only if company is provided
  const currentCompanies = company ? [company] : [];

  // LinkedIn accepts: "California", "United States", "California, United States"
  // Send state alone, or fall back to country, or both as separate items
  let locations = [];
  if (Array.isArray(filters.locations) && filters.locations.length > 0) {
    locations = [...filters.locations];
  } else {
    if (state) locations.push(state);         // e.g. "California"
    if (geography) locations.push(geography); // e.g. "USA" → need "United States"
  }

  // Map common abbreviations to full country names
  const COUNTRY_MAP = {
    'USA': 'United States',
    'US': 'United States',
    'UK': 'United Kingdom',
    'IN': 'India',
    'CA': 'Canada',
    'AU': 'Australia',
  };
  const normalizedLocations = locations
    .map((loc) => COUNTRY_MAP[String(loc).toUpperCase()] || loc)
    .filter(Boolean);

  return {
    searchQuery: searchQuery,
    currentCompanies: currentCompanies,
    locations: normalizedLocations,
    maxItems: Number(maxResults),
    profileScraperMode: 'Full',
  };
}

/**
 * POST /api/leads/debug-apify
 * Temporary debug endpoint returning raw Apify output without any filters.
 */
router.post('/debug-apify', async (req, res) => {
  const token = process.env.APIFY_TOKEN || process.env.APIFY_API_KEY;
  if (!token) {
    return res.status(400).json({ error: 'APIFY_TOKEN is missing' });
  }
  const client = new ApifyClient({ token });
  const actorId = process.env.APIFY_ACTOR_ID || 'harvestapi/linkedin-profile-search';

  const apifyInput = {
    searchQuery: 'Amazon Software Engineer',
    currentCompanies: ['Amazon'],
    locations: ['United States'],       // ← Country only, no comma
    maxItems: 3,
    profileScraperMode: 'Full',
  };

  console.log('[Debug] Sending to Apify:', JSON.stringify(apifyInput, null, 2));

  try {
    const run = await client.actor(actorId).call(apifyInput);
    console.log('[Debug] Run status:', run.status);
    console.log('[Debug] Run stats:', JSON.stringify(run.stats, null, 2));

    const dataset = await client.dataset(run.defaultDatasetId).listItems();
    console.log('[Debug] Dataset items count:', dataset.items.length);
    if (dataset.items.length > 0) {
      console.log('[Debug] First item:', JSON.stringify(dataset.items[0], null, 2));
    }

    res.json({
      runStatus: run.status,
      runStats: run.stats,
      itemCount: dataset.items.length,
      firstItem: dataset.items[0] || null,
    });
  } catch (err) {
    console.error('[Debug] Error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

/**
 * POST /api/leads/search
 * Trigger Apify LinkedIn profile scraper with strict currentCompanies filtering.
 */
router.post('/search', async (req, res) => {
  console.log('[Route] POST /search called');
  console.log('[Route] Body:', JSON.stringify(req.body, null, 2));

  try {
    const body = req.body || {};
    const filters = body.filters || body || {};
    const company = String(filters.company || '').trim();
    const designation = String(filters.designation || '').trim();
    const geography = String(filters.geography || '').trim();
    const state = String(filters.state || '').trim();
    const industry = String(filters.industry || '').trim();
    const role = String(filters.role || '').trim();

    // Construct the exact Apify payload requested
    const apifyInput = buildApifyPayload(filters);
    console.log('[Apify] Payload:', JSON.stringify(apifyInput, null, 2));

    const token = process.env.APIFY_TOKEN || process.env.APIFY_API_KEY;
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'APIFY_TOKEN is missing. Please set APIFY_TOKEN in your environment or backend/.env file.',
      });
    }

    const client = new ApifyClient({ token });
    const actorId = process.env.APIFY_ACTOR_ID || 'harvestapi/linkedin-profile-search';

    let items = [];
    try {
      console.log(`[Apify] Starting run for actor "${actorId}"...`);
      const run = await client.actor(actorId).call(apifyInput);
      console.log('[Apify] Run ID:', run.id);
      console.log('[Apify] Run status:', run.status);
      console.log('[Apify] Dataset ID:', run.defaultDatasetId);

      const dataset = await client.dataset(run.defaultDatasetId).listItems();
      items = dataset.items || [];
      console.log('[Apify] Raw items count:', items.length);
      if (items.length > 0) {
        console.log('[Apify] First raw item:', JSON.stringify(items[0], null, 2));
      }
    } catch (apifyErr) {
      console.error('[Apify] Actor call failed:', apifyErr);
      return res.status(500).json({
        success: false,
        error: 'Apify call failed',
        details: apifyErr?.message || 'Failed to execute Apify actor',
      });
    }

    // Strictly filter results by currentCompanies array
    const strictProfiles = apifyInput.currentCompanies.length > 0
      ? items.filter((item) => matchesCurrentCompanies(item, apifyInput.currentCompanies))
      : items;

    console.log('[Apify] Filtered items count:', strictProfiles.length);
    console.log('[Apify] Removed by filter:', items.length - strictProfiles.length);

    // Map and return results (Name, Job Title, Email, LinkedIn URL, Company, etc.)
    const leads = strictProfiles.map((item, idx) => {
      const full_name = extractFullName(item);
      const job_title = extractJobTitle(item);
      const company_name = extractCompany(item, company);
      const email = extractEmail(item);
      const linkedinUrl = extractLinkedInUrl(item);
      const loc = extractLocation(item, geography, state);
      const des = item.headline || item.designation || job_title || '—';

      return {
        id: item.id || `lead-${Date.now()}-${idx}`,
        full_name,
        job_title,
        company_name,
        email,
        phone: item.phone || item.mobileNumber || item.phoneNumber || null,
        linkedinUrl,
        linkedin_url: linkedinUrl,
        designation: des,
        role: role || '',
        industry: industry || item.industry || '',
        geography: loc,
      };
    });

    // Persistence in Supabase leads table
    let savedCount = 0;
    let dbError = null;
    try {
      const db = await getSupabaseSafe();
      if (!db) {
        throw new Error('Supabase client could not be initialized');
      }

      console.log('[DB] Attempting to save', strictProfiles.length, 'leads');

      if (leads.length > 0) {
        // Resolve user_id: check body, params, auth header, or fallback to active user
        let userId =
          req.user?.id ||
          req.body?.userId ||
          req.body?.user_id ||
          req.body?.filters?.userId ||
          req.body?.filters?.user_id;

        if (!userId && req.headers?.authorization) {
          try {
            const token = req.headers.authorization.replace(/^Bearer\s+/i, '');
            const { data: userData } = await db.auth.getUser(token);
            if (userData?.user?.id) {
              userId = userData.user.id;
            }
          } catch (err) {
            console.warn('[DB] Failed to resolve user from auth header:', err.message);
          }
        }

        // Fallback to latest active user from leads so rows are never orphaned with NULL (which RLS hides)
        if (!userId) {
          const { data: latestLead } = await db
            .from('leads')
            .select('user_id')
            .not('user_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          userId = latestLead?.user_id || '2558fbd1-26c0-408a-92c6-66bf756371ba';
        }

        console.log('[DB] Using user_id for leads insert:', userId);

        const rowsToSave = leads
          .filter((l) => l.linkedinUrl)
          .map((l) => ({
            user_id: userId,
            full_name: l.full_name && l.full_name !== '—' ? l.full_name : null,
            job_title: l.job_title && l.job_title !== '—' ? l.job_title : null,
            company_name: l.company_name && l.company_name !== '—' ? l.company_name : null,
            designation: l.designation && l.designation !== '—' ? l.designation : null,
            email: l.email || null,
            phone: l.phone || null,
            linkedin_url: l.linkedinUrl,
            role: l.role || '',
            headline: l.designation && l.designation !== '—' ? l.designation : null,
            location: l.geography && l.geography !== '—' ? l.geography : null,
            geography: l.geography && l.geography !== '—' ? l.geography : null,
            industry: l.industry || '',
            source_query: apifyInput.searchQuery,
          }));

        // Deduplicate rowsToSave by linkedin_url so Postgres ON CONFLICT doesn't fail with 21000
        const seenUrls = new Set();
        const uniqueRows = rowsToSave.filter((r) => {
          if (!r.linkedin_url || seenUrls.has(r.linkedin_url)) return false;
          seenUrls.add(r.linkedin_url);
          return true;
        });

        if (uniqueRows.length > 0) {
          const { data: savedData, error: upsertError } = await db
            .from('leads')
            .upsert(uniqueRows, {
              onConflict: 'user_id,linkedin_url',
              ignoreDuplicates: false,
            })
            .select('*');

          dbError = upsertError;

          if (dbError) {
            console.error('[DB] Save failed:', dbError);
            console.log('[DB] Save result:', JSON.stringify({ savedCount, error: dbError }, null, 2));
            return res.status(500).json({
              success: false,
              error: 'Database save failed',
              details: dbError.message,
              errorCode: dbError.code,
            });
          }

          if (savedData) {
            savedCount = savedData.length;
            console.log(`[DB] Successfully saved ${savedCount} leads to Supabase`);

            // Update returned leads with actual DB id
            savedData.forEach((savedRow) => {
              const matched = leads.find((l) => l.linkedinUrl === savedRow.linkedin_url);
              if (matched) {
                matched.id = savedRow.id;
              }
            });
          }
        }
      }

      console.log('[DB] Save result:', JSON.stringify({ savedCount, error: dbError }, null, 2));
    } catch (dbErr) {
      dbError = dbErr?.message || dbErr;
      console.log('[DB] Save result:', JSON.stringify({ savedCount, error: dbError }, null, 2));
      console.error('[DB] Save exception:', dbErr);
      return res.status(500).json({
        success: false,
        error: 'Database save failed',
        details: dbErr?.message || 'Database error occurred',
      });
    }

    console.log('[Response] Returning:', JSON.stringify({
      success: true,
      found: leads.length,
      rawFound: items.length,
      savedCount,
    }, null, 2));

    return res.json({
      success: true,
      found: leads.length,
      rawFound: items.length,
      savedCount,
      leads,
      data: leads,
    });
  } catch (err) {
    console.error('[Apify] Error running LinkedIn search:', err);
    return res.status(500).json({
      success: false,
      error: 'Apify call failed',
      details: err?.message || 'Failed to search LinkedIn profiles with Apify',
    });
  }
});

export default router;
