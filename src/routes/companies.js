import { json } from './_utils.js';
import { SEED_COMPANIES, BATCH_WATCHLIST, WATCH_GROUPS } from '../config.js';
import { fetchHiringCafe } from '../adapters.js';
import {
  loadCompanyList, saveCompanyList,
  loadDoRegistry, saveDoRegistry,
  loadProfile, saveProfile,
} from '../state.js';
// bootstrapDOs, detectAts, fetchResumeFromOneDrive, generateAndStoreKeywords
// live in index.js (also used by cron). Circular import is safe — these
// bindings are only referenced inside async handlers.
import {
  bootstrapDOs, detectAts, fetchResumeFromOneDrive, generateAndStoreKeywords,
} from '../index.js';

export async function handleCompanies(request, url, env) {
  // GET /companies — list watchlist with platform DO status
  if (url.pathname === '/companies' && request.method === 'GET') {
    const companies = await loadCompanyList(env) ?? SEED_COMPANIES;
    const registry  = await loadDoRegistry(env);
    // Group by ATS platform
    const byPlatform = {};
    for (const c of companies) {
      if (!byPlatform[c.ats]) byPlatform[c.ats] = [];
      byPlatform[c.ats].push(c);
    }
    return json({
      total: companies.length,
      batchWatchlist: BATCH_WATCHLIST.length,
      totalMonitored: companies.length + BATCH_WATCHLIST.length,
      platforms: Object.entries(byPlatform).map(([ats, cos]) => ({
        ats,
        count: cos.length,
        doActive: !!registry[`platform:${ats}`],
        companies: cos.map(c => c.name),
      })),
    });
  }

  // POST /companies — add a company to the watchlist
  // POST /detect-ats — auto-detect ATS type and token from a career URL
  // Body: { url: "https://boards.greenhouse.io/nordicglobal" }
  // Returns: { ats, token, url } or { error }
  // Powers the UI "Paste URL" fast-add flow.
  if (url.pathname === '/detect-ats' && request.method === 'POST') {
    try {
      const { url: rawUrl } = await request.json();
      if (!rawUrl) return json({ error: 'url required' }, 400);
      const result = detectAts(rawUrl);
      if (!result) return json({ error: 'ATS not recognized from URL' }, 422);
      return json(result);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }

  if (url.pathname === '/companies' && request.method === 'POST') {
    const company = await request.json();
    if (!company.name || !company.ats) {
      return json({ error: 'name and ats are required' }, 400);
    }
    const companies = await loadCompanyList(env) ?? [];
    const doKey = `${company.ats}:${company.token ?? company.name}`;
    const exists = companies.some(c => `${c.ats}:${c.token ?? c.name}` === doKey);
    if (exists) return json({ error: 'Company already in watchlist' }, 409);
    companies.push(company);
    await saveCompanyList(env, companies);
    // Platform DOs load company_list on every alarm cycle — no per-company init needed.
    // The platform DO for this ATS will pick up the new company on its next alarm.
    const registry = await loadDoRegistry(env);
    registry[doKey] = { name: company.name, ats: company.ats, startedAt: new Date().toISOString() };
    await saveDoRegistry(env, registry);
    return json({ ok: true, company: company.name, doKey });
  }

  // GET /platform/:ats/status — check a platform DO (e.g. /platform/greenhouse/status)
  if (url.pathname.startsWith('/platform/') && request.method === 'GET') {
    const ats = url.pathname.split('/')[2]?.replace('/status', '');
    const PLATFORM_MAP = {
      greenhouse: 'GREENHOUSE_DO', lever: 'LEVER_DO', ashby: 'ASHBY_DO',
      workday: 'WORKDAY_DO', icims: 'ICIMS_DO',
      successfactors: 'SUCCESSFACTORS_DO', taleo: 'TALEO_DO',
      oracle_hcm: 'ORACLE_HCM_DO',
      infor_hcm:  'INFOR_HCM_DO',
      selectminds: 'SELECTMINDS_DO',
    };
    const binding = PLATFORM_MAP[ats];
    if (!binding || !env[binding]) return json({ error: `Unknown platform: ${ats}` }, 404);
    const id   = env[binding].idFromName(ats);
    const stub = env[binding].get(id);
    const res  = await stub.fetch(new Request('https://stat-internal/status'));
    return res;
  }

  // POST /bootstrap — manually spawn all DOs
  if (url.pathname === '/bootstrap' && request.method === 'POST') {
    const result = await bootstrapDOs(env);

    // Auto-fetch resume from OneDrive if configured and no profile stored yet
    let resumeStatus = 'skipped';
    if (env.ONEDRIVE_RESUME_URL) {
      const existing = await loadProfile(env).catch(() => null);
      if (!existing) {
        const profile = await fetchResumeFromOneDrive(env).catch(() => null);
        if (profile) {
          profile._fetchedAt = new Date().toISOString();
          await saveProfile(env, profile);
          // Generate keywords from OneDrive-fetched profile
          generateAndStoreKeywords(profile, env).catch(e =>
            console.warn('[STAT] keyword gen failed:', e.message)
          );
          resumeStatus = 'fetched: ' + (profile.headline || 'ok');
        } else {
          resumeStatus = 'fetch failed — check ONEDRIVE_RESUME_URL';
        }
      } else {
        resumeStatus = 'profile already stored';
      }
    }

    return json({ ok: true, spawned: result.spawned, total: result.companies.length, resumeStatus });
  }

  // ── GET /br-test?url={url}&ats={ats} ──────────────────────────────────────
  // Browser Rendering diagnostic endpoint.
  // Runs headless Chromium against any URL, waits for JS to execute,
  // then extracts: og:description, page title, job links, DOM text excerpt.
  // Used to verify Browser Rendering works against iCIMS/Taleo SPAs and
  // to harvest real job URLs from their rendered DOM for further testing.
  // ── GET /harvest — discover new companies from HiringCafe ─────────────────
  // Runs fetchHiringCafe() across all WATCH_GROUPS keywords and environments.
  // Returns company+ATS pairs not already in the current company watchlist.
  // Used by CI harvest workflow to bulk-discover new companies.
  // Worker IP is not blocked by HiringCafe (proven — 1-min cron works).
  if (url.pathname === '/harvest' && request.method === 'GET') {
    const HARVEST_TERMS = [
      'epic analyst', 'epic ambulatory', 'epic application analyst',
      'ehr analyst', 'ehr application analyst', 'clarity sql',
      'epic implementation', 'epic consultant', 'epic inpatient',
      'epic reporting', 'epic cogito', 'epic caboodle',
      'epic within', 'epic cadence', 'epic mychart',
      'epic optime', 'epic beacon', 'epic radiant', 'epic willow', 'epic resolute',
      'clinical informatics analyst', 'healthcare it analyst',
      'health informatics analyst', 'epic training analyst',
      'epic build analyst', 'epic go live',
      'cerner analyst', 'meditech analyst',
      'health information management', 'revenue cycle analyst',
      'remote customer service', 'remote customer success',
      'remote logistics coordinator', 'remote supply chain analyst',
      'remote data analyst', 'remote sql analyst',
    ];
    const ENVS = ['remote', 'hybrid'];

    // Load current company list for dedup
    const knownCompanies = await loadCompanyList(env) ?? SEED_COMPANIES;
    const knownNames  = new Set(knownCompanies.map(c => c.name.toLowerCase().trim()));
    const knownTokens = new Set(knownCompanies.filter(c => c.token).map(c => c.token.toLowerCase()));
    const knownUrls   = new Set(knownCompanies.filter(c => c.url).map(c => c.url.toLowerCase()));

    const discovered = new Map(); // key: ats:token → {company, ats, token, hits}
    const allSeenCompanies = []; // for debug mode
    let totalCalls = 0;

    for (const term of HARVEST_TERMS) {
      for (const envType of ENVS) {
        try {
          const jobs = await fetchHiringCafe(term, envType);
          totalCalls++;
          for (const job of jobs) {
            const company  = (job.company || '').trim();
            const atsSource = job.hc?.atsSource || job.atsSource || '';
            const token    = job.hc?.boardToken || '';
            const applyUrl = job.url || '';

            if (!company || company.length < 3) continue;
            const SUPPORTED = ['greenhouse','lever','ashby','workday','icims','successfactors','taleo'];
            if (atsSource && SUPPORTED.includes(atsSource)) {
              allSeenCompanies.push({company, ats: atsSource, known: knownNames.has(company.toLowerCase())});
            }
            if (knownNames.has(company.toLowerCase())) continue;

            // Determine ATS and canonical token/url
            if (!SUPPORTED.includes(atsSource)) continue;

            const tokenVal = token || (atsSource === 'workday' ? applyUrl : '');
            if (!tokenVal || tokenVal.length < 3) continue;
            if (knownTokens.has(tokenVal.toLowerCase())) continue;
            if (knownUrls.has(tokenVal.toLowerCase())) continue;

            const key = atsSource + ':' + tokenVal.toLowerCase();
            if (!discovered.has(key)) {
              discovered.set(key, { company, ats: atsSource, token: tokenVal, hits: 0 });
            }
            discovered.get(key).hits++;
          }
        } catch (e) {
          console.warn('[STAT harvest]', term, envType, e.message);
        }
        // Small delay to be polite
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const results = [...discovered.values()].sort((a, b) =>
      a.ats.localeCompare(b.ats) || a.company.localeCompare(b.company)
    );

    // Summary by ATS
    const byAts = {};
    for (const r of results) {
      if (!byAts[r.ats]) byAts[r.ats] = [];
      byAts[r.ats].push(r.company);
    }

    const debug = url.searchParams.get('debug') === '1';
    const allSeen = debug ? allSeenCompanies : undefined;

    return json({
      ok: true,
      total_calls: totalCalls,
      count: results.length,
      by_ats: Object.fromEntries(Object.entries(byAts).map(([k,v]) => [k, v.length])),
      companies: results,
      ...(debug ? { all_seen_count: allSeenCompanies.length, all_seen: allSeenCompanies.slice(0,50) } : {}),
    });
  }


  return null;
}
