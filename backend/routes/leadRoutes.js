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
 * Filter results strictly by target name if specified.
 */
export function matchesName(item, targetName) {
  if (!targetName || !String(targetName).trim()) return true;
  const target = String(targetName).trim().toLowerCase();
  const fullName = extractFullName(item).trim().toLowerCase();
  if (!fullName || fullName === '—') return false;

  // Direct substring match
  if (fullName.includes(target)) return true;

  // Token matching (all parts of targetName must exist in fullName)
  const tokens = target.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => fullName.includes(token))) {
    return true;
  }

  // Check first / last name
  const first = String(item.firstName || '').trim().toLowerCase();
  const last = String(item.lastName || '').trim().toLowerCase();
  const combined = `${first} ${last}`.trim();
  if (combined && (combined.includes(target) || (tokens.length > 0 && tokens.every((t) => combined.includes(t))))) {
    return true;
  }

  return false;
}

export function postFilterByName(item, targetName) {
  if (!targetName || !String(targetName).trim()) return true;
  const target = String(targetName).trim().toLowerCase();
  const fullName = extractFullName(item).trim().toLowerCase();
  const nameField = String(item.name || '').trim().toLowerCase();
  return (fullName !== '—' && fullName.includes(target)) || nameField.includes(target);
}

/**
 * Builds tiered search payloads according to the fallback strategy:
 * Tier 1: Full query: searchQuery="{Name} {Designation} {Industry}", locations=["{Geography}", "{State}"], currentCompanies=["{Company}"]
 * Tier 2: Company filter removed: currentCompanies removed
 * Tier 3: Name only with Geography: searchQuery="{Name}", locations=["{Geography}"]
 * Tier 4: Company only with Geography (if Name is empty): searchQuery="{Company}", locations=["{Geography}"]
 */
export function getSearchTiers(filters = {}) {
  const name = String(filters.name || filters.fullName || '').trim();
  const designation = String(filters.designation || '').trim();
  const industry = String(filters.industry || '').trim();
  const company = String(filters.company || '').trim();
  const geography = String(filters.geography || '').trim();
  const state = String(filters.state || '').trim();
  const maxItems = Number(filters.maxItems || filters.maxResults || filters.numProfiles || 5) || 5;

  const COUNTRY_MAP = {
    'USA': 'United States',
    'US': 'United States',
    'UK': 'United Kingdom',
    'IN': 'India',
    'CA': 'Canada',
    'AU': 'Australia',
  };
  const normGeo = geography ? (COUNTRY_MAP[geography.toUpperCase()] || geography) : '';
  const normState = state || '';

  const tier1Query = [name, designation, industry].filter(Boolean).join(' ').trim() || (company || 'CEO');
  const tier1Locations = [normGeo, normState].filter(Boolean);
  const tier1Companies = company ? [company] : [];

  const tiers = [
    {
      tier: 1,
      name: 'Tier 1',
      description: 'Tier 1 — Full query with all filters',
      shortDescription: 'Full query with all filters',
      payload: {
        searchQuery: tier1Query,
        locations: tier1Locations,
        ...(tier1Companies.length > 0 ? { currentCompanies: tier1Companies } : {}),
        maxItems,
        profileScraperMode: 'Full',
      },
    },
  ];

  if (tier1Companies.length > 0) {
    tiers.push({
      tier: 2,
      name: 'Tier 2',
      description: 'Tier 2 — Company filter removed',
      shortDescription: 'Company filter removed',
      payload: {
        searchQuery: tier1Query,
        locations: tier1Locations,
        maxItems,
        profileScraperMode: 'Full',
      },
    });
  }

  if (name) {
    tiers.push({
      tier: 3,
      name: 'Tier 3',
      description: 'Tier 3 — Name only with Geography',
      shortDescription: 'Name only with Geography',
      payload: {
        searchQuery: name,
        locations: normGeo ? [normGeo] : [],
        maxItems,
        profileScraperMode: 'Full',
      },
    });
  }

  if (!name && company) {
    tiers.push({
      tier: 4,
      name: 'Tier 4',
      description: 'Tier 4 — Company only with Geography',
      shortDescription: 'Company only with Geography',
      payload: {
        searchQuery: company,
        locations: normGeo ? [normGeo] : [],
        maxItems,
        profileScraperMode: 'Full',
      },
    });
  }

  return tiers;
}

export function buildApifyPayload(filters = {}) {
  const tiers = getSearchTiers(filters);
  return tiers[0]?.payload || {};
}

/**
 * POST /api/leads/debug-apify
 * Temporary debug endpoint returning raw Apify output without any filters.
 */
router.post('/debug-apify', async (req, res) => {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return res.status(400).json({ error: 'Missing required env var: APIFY_TOKEN' });
  }
  const actorId = process.env.APIFY_ACTOR_ID;
  if (!actorId) {
    return res.status(400).json({ error: 'Missing required env var: APIFY_ACTOR_ID' });
  }
  const client = new ApifyClient({ token });

  const apifyInput = {
    searchQuery: 'Amazon Software Engineer',
    currentCompanies: ['Amazon'],
    locations: ['United States'],
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
 * Trigger Apify LinkedIn profile scraper with Tiered fallback and post-filtering.
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
    const name = String(filters.name || filters.fullName || '').trim();

    const token = process.env.APIFY_TOKEN;
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Missing required env var: APIFY_TOKEN. Please set APIFY_TOKEN in your environment or backend/.env file.',
      });
    }

    const actorId = process.env.APIFY_ACTOR_ID;
    if (!actorId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required env var: APIFY_ACTOR_ID. Please set APIFY_ACTOR_ID in your environment or backend/.env file.',
      });
    }

    const client = new ApifyClient({ token });

    const tiers = getSearchTiers(filters);
    console.log(`[Apify] Prepared ${tiers.length} search tiers`);

    let winningTier = null;
    let winningItems = [];
    const tierAttempts = [];
    let lastApifyError = null;

    for (const t of tiers) {
      console.log(`[Apify] Running ${t.description} -> payload:`, JSON.stringify(t.payload, null, 2));

      let run = null;
      let rawItems = [];
      let attemptError = null;

      try {
        run = await client.actor(actorId).call(t.payload);
        console.log(`[Apify] ${t.name} Run ID:`, run.id, 'Status:', run.status, 'statusMessage:', run.statusMessage);

        if (run.statusMessage) {
          lastApifyError = run.statusMessage;
        }

        const dataset = await client.dataset(run.defaultDatasetId).listItems();
        rawItems = dataset.items || [];
        console.log(`[Apify] ${t.name} Raw items count:`, rawItems.length);
      } catch (err) {
        console.error(`[Apify] ${t.name} Actor call failed:`, err);
        attemptError = err.message;
        lastApifyError = err.message;
      }

      // Post-filter results by name
      // Because the actor uses fuzzy search, keep only profiles whose name (or fullName) field
      // contains the entered Name value (case-insensitive, trimmed). If Name is empty, skip this step.
      let matchedItems = rawItems;
      if (name) {
        matchedItems = rawItems.filter((item) => postFilterByName(item, name));
      }

      tierAttempts.push({
        tier: t.tier,
        name: t.name,
        description: t.description,
        payload: t.payload,
        status: run?.status || (attemptError ? 'FAILED' : 'UNKNOWN'),
        statusMessage: run?.statusMessage || attemptError || null,
        rawItemsCount: rawItems.length,
        matchedItemsCount: matchedItems.length,
        rawItemsSample: rawItems.slice(0, 3),
      });

      if (matchedItems.length > 0) {
        winningTier = t;
        winningItems = matchedItems;
        console.log(`[Apify] ${t.description} SUCCEEDED with ${matchedItems.length} matching leads!`);
        break; // Stop fallback immediately
      } else {
        console.log(`[Apify] ${t.description} returned 0 matching leads. Proceeding to next tier...`);
      }
    }

    // Tier 5: If all tiers return 0, do NOT fabricate results. Return raw Apify request & response JSON.
    if (!winningTier || winningItems.length === 0) {
      const isLimit = lastApifyError && /limit|credit|quota|reach|exceed/i.test(lastApifyError);
      const friendlyError = lastApifyError
        ? (isLimit ? `Apify run limit reached: ${lastApifyError}` : `Apify error: ${lastApifyError}`)
        : null;

      return res.json({
        success: true,
        found: 0,
        savedCount: 0,
        tier: null,
        tierDescription: friendlyError || 'All tiers returned 0 matching profiles',
        tierAttempts,
        leads: [],
        data: [],
        apifyError: friendlyError,
        message: friendlyError || 'All search tiers returned 0 matching profiles.',
      });
    }

    const strictProfiles = winningItems;
    console.log(`[Apify] Final profiles to process from ${winningTier.name}:`, strictProfiles.length);

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
        name: full_name && full_name !== '—' ? full_name : (item.name || null),
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
          .map((l) => {
            const resolvedName = (l.name || l.full_name) && (l.name || l.full_name) !== '—' ? (l.name || l.full_name) : null;
            return {
              user_id: userId,
              name: resolvedName,
              full_name: resolvedName,
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
              source_query: winningTier?.payload?.searchQuery || '',
            };
          });

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

    const tierDescription = `Found ${leads.length} lead${leads.length === 1 ? '' : 's'} on ${winningTier.name} — ${winningTier.shortDescription}`;

    console.log('[Response] Returning:', JSON.stringify({
      success: true,
      found: leads.length,
      savedCount,
      tier: winningTier.tier,
      tierDescription,
    }, null, 2));

    return res.json({
      success: true,
      found: leads.length,
      savedCount,
      tier: winningTier.tier,
      tierDescription,
      tierAttempts,
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
