/**
 * STAT — Main Worker
 *
 * Entry points:
 *   scheduled()  — 1-min cron: HiringCafe wide-net scrape + DO health
 *   fetch()      — HTTP endpoints: /status /trigger /reset /companies /stop
 *
 * Architecture:
 *   Tier 1 (fast, ~30-120s): CompanyWatcherDO per employer — direct ATS polling
 *   Tier 2 (wide-net, 1min): Cron-driven HiringCafe scrape + unknown-company catch
 *
 * FIELD infrastructure lessons applied:
 *   - DO alarm pattern from FIELD GameDO / ATP Mitigation doc
 *   - KV dedup from FIELD score store pattern
 *   - Relay-is-dumb: this worker fetches facts, caller decides relevance
 *   - No intelligence in the Worker itself — all matching in config + notify
 */

export { SalaryInferenceDO } from './salary.js';
export { BatchPollerDO } from './batch.js';
export {
  GreenhouseDO, LeverDO, AshbyDO, WorkdayDO,
  IcimsDO, SuccessFactorsDO, TaleoDO,
} from './platform-do.js';

import { SEED_COMPANIES, BATCH_WATCHLIST, KV, HIRINGCAFE, BATCH_POLLER, LEARNING } from './config.js';
import { bootstrapSalaryDO, enrichJobWithSalary } from './salary.js';
import { applyMarylandScore } from './maryland.js';
import { enrichDescriptions } from './enrich.js';
import { fetchHiringCafe, fetchHiringCafeBR, mapHiringCafeHit, fetchHcDescription } from './adapters.js';
import { matchJob, passesEnvFilter, dispatchAlerts, checkJobLiveness } from './notify.js';
import { scoreBatch, companyAwarePriority } from './fit.js';
import puppeteer from '@cloudflare/puppeteer';
import { getStatStore, storeGet, storeSet, storeDel, saveRecentMatches, loadRecentMatches, loadUnmatchedJobs, saveUnmatchedJobs, appendLog, readLog, maybeAddOrPromoteCompany } from './store.js';
export { StateStoreDO } from './store.js';
import UI_HTML from './ui.html';

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE — DO SQLite helpers (via StateStoreDO)
// All five previously-KV keys now live in StateStoreDO SQLite storage.
// Helpers accept env and derive the stub internally for a clean call site.
// ─────────────────────────────────────────────────────────────────────────────
async function loadSeenIds(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'seen_ids');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

async function saveSeenIds(env, seenSet) {
  let arr = Array.from(seenSet);
  if (arr.length > KV.max_seen) arr = arr.slice(-KV.max_seen);
  await storeSet(getStatStore(env), 'seen_ids', JSON.stringify(arr));
}

async function loadCompanyList(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'company_list');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function saveCompanyList(env, list) {
  await storeSet(getStatStore(env), 'company_list', JSON.stringify(list));
}

async function loadDoRegistry(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'do_registry');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function saveDoRegistry(env, registry) {
  await storeSet(getStatStore(env), 'do_registry', JSON.stringify(registry));
}

async function loadProfile(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'resume_profile');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function saveProfile(env, p) {
  await storeSet(getStatStore(env), 'resume_profile', JSON.stringify(p));
}

async function loadMatchCounts(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'match_counts');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
async function saveMatchCounts(env, c) {
  await storeSet(getStatStore(env), 'match_counts', JSON.stringify(c));
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE-DRIVEN KEYWORD GENERATION
// When a profile is stored, generate a personalized keyword list via Gemini
// and store it in StateStoreDO. matchJob() uses this list + the static list.
// Gives STAT contextual understanding of what jobs fit this specific person.
// ─────────────────────────────────────────────────────────────────────────────

async function generateAndStoreKeywords(profile, env) {
  if (!profile || !env.GEMINI_KEY) return null;
  try {
    const prompt = `You are a healthcare IT job search expert. Given this candidate profile, generate job title keywords that identify relevant positions.

PROFILE:
- Role: ${profile.headline || ''}
- Years experience: ${profile.yearsExperience || '?'}
- Epic modules: ${(profile.epicModules || []).join(', ')}
- Certifications: ${(profile.certifications || []).join(', ')}
- Skills: ${(profile.skills || []).join(', ')}
- Target roles: ${(profile.targetRoles || []).join(', ')}

Generate at THREE levels:
1. EXACT: phrases verbatim in Epic/EHR job titles (e.g. "epic ambulatory analyst")
2. BROAD: single words strongly indicating relevance (e.g. "ambulatory", "cogito", "clarity")
3. ADJACENT: related roles this person could pivot to (e.g. "clinical informatics", "application coordinator")

IMPORTANT: also include certification-opportunity signals in EXACT:
- "within epic", "epic certification", "epic training", "epic go-live", "epic build"
- These appear in JOB DESCRIPTIONS (not titles) and signal employers who sponsor certification
- Epic certification costs $1,000-$3,000/module — sponsored roles are extremely high value

Return ONLY JSON, no markdown:
{"exact":["phrase1","phrase2"],"broad":["word1","word2"],"adjacent":["phrase1","phrase2"]}

Max 20 per category. All lowercase.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 600, temperature: 0.1 },
        }),
      }
    );
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
    const keywords = JSON.parse(cleaned);

    // Store in StateStoreDO
    const stub = getStatStore(env);
    await storeSet(stub, 'custom_keywords', JSON.stringify({
      keywords,
      generatedAt: new Date().toISOString(),
      profileHeadline: profile.headline || '',
    }));

    console.log('[STAT keywords] Generated:', 
      keywords.exact?.length, 'exact,',
      keywords.broad?.length, 'broad,',
      keywords.adjacent?.length, 'adjacent');
    return keywords;
  } catch (e) {
    console.warn('[STAT keywords] Generation failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ONEDRIVE RESUME AUTO-FETCH
// Fetches resume from a OneDrive public share link, extracts text,
// and stores the profile — no user interaction required.
// Requires: ONEDRIVE_RESUME_URL secret (share link with "Anyone can view")
// ─────────────────────────────────────────────────────────────────────────────

async function fetchResumeFromOneDrive(env) {
  if (!env.ONEDRIVE_RESUME_URL || !env.GEMINI_KEY) return null;

  let downloadUrl = env.ONEDRIVE_RESUME_URL;
  // OneDrive share links support ?download=1 for direct download
  const sep = downloadUrl.includes('?') ? '&' : '?';
  if (!downloadUrl.includes('download=1')) {
    downloadUrl = downloadUrl + sep + 'download=1';
  }

  let res;
  try {
    res = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'STAT-resume-fetch/1.0' },
      redirect: 'follow',
    });
  } catch (e) {
    console.warn('[STAT resume] fetch error:', e.message);
    return null;
  }

  if (!res.ok) {
    console.warn('[STAT resume] OneDrive fetch failed:', res.status);
    return null;
  }

  const contentType = res.headers.get('content-type') || '';
  let resumeText = '';

  if (contentType.includes('text/')) {
    resumeText = await res.text();
  } else if (
    contentType.includes('openxmlformats') ||
    contentType.includes('msword') ||
    downloadUrl.match(/\.docx?(\?|$)/i)
  ) {
    const bytes = await res.arrayBuffer();
    resumeText = extractDocxText(bytes);
  } else {
    // Try as text for PDF or unknown — works for text-based PDFs
    resumeText = await res.text();
  }

  if (!resumeText || resumeText.length < 100) {
    console.warn('[STAT resume] text too short:', resumeText.length);
    return null;
  }

  console.log('[STAT resume] fetched from OneDrive:', resumeText.length, 'chars');

  // Extract structured profile via Gemini
  const systemPrompt = `You are a healthcare IT hiring specialist with deep knowledge of Epic EHR implementations.
Extract the candidate profile as JSON with EXACTLY these fields (use empty arrays/null if not present):
{
  "headline": "2-3 word professional summary",
  "yearsExperience": number or null,
  "epicModules": ["array of Epic module names"],
  "otherSystems": ["other EHR/HIT systems"],
  "certifications": ["Epic and other certs"],
  "skills": ["top 6 technical skills"],
  "targetRoles": ["appropriate job titles"],
  "environments": ["remote","hybrid","onsite"],
  "matchStrengths": ["3 strongest selling points"],
  "potentialGaps": ["2-3 genuine gaps"]
}
Return ONLY the JSON object, no markdown, no explanation.`;

  try {
    const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + env.GEMINI_KEY;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: resumeText.slice(0, 8000) }] }],
        generationConfig: { maxOutputTokens: 800, temperature: 0.1 },
      }),
    });
    const geminiData = await geminiRes.json();
    const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
    const profile = JSON.parse(cleaned);
    await saveProfile(env, profile);
    console.log('[STAT resume] profile saved:', profile.headline);
    return profile;
  } catch (e) {
    console.warn('[STAT resume] extraction failed:', e.message);
    return null;
  }
}

function extractDocxText(arrayBuffer) {
  // docx = ZIP containing word/document.xml
  // Scan binary for the XML block and extract <w:t> text nodes
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const raw = decoder.decode(new Uint8Array(arrayBuffer));
  const start = raw.indexOf('<w:document');
  const end = raw.indexOf('</w:document>');
  if (start === -1) return '';
  const xml = raw.slice(start, end + 14);
  const texts = [];
  const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[1].trim()) texts.push(m[1]);
  }
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}


// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP DOs for all companies in the watchlist
// Called on first deploy and when new companies are added.
// ─────────────────────────────────────────────────────────────────────────────
async function bootstrapDOs(env) {
  // Load or initialize company watchlist
  let companies = await loadCompanyList(env);
  if (!companies) {
    companies = SEED_COMPANIES;
    await saveCompanyList(env, companies);
  }

  // Platform DO map: binding name → ATS key
  const PLATFORM_DOS = [
    { binding: 'GREENHOUSE_DO',     ats: 'greenhouse' },
    { binding: 'LEVER_DO',          ats: 'lever' },
    { binding: 'ASHBY_DO',          ats: 'ashby' },
    { binding: 'WORKDAY_DO',        ats: 'workday' },
    { binding: 'ICIMS_DO',          ats: 'icims' },
    { binding: 'SUCCESSFACTORS_DO', ats: 'successfactors' },
    { binding: 'TALEO_DO',          ats: 'taleo' },
  ];

  const registry = await loadDoRegistry(env);
  let spawned = 0;

  for (const { binding, ats } of PLATFORM_DOS) {
    const key = `platform:${ats}`;
    if (registry[key]) continue; // already running
    const doBinding = env[binding];
    if (!doBinding) continue;
    try {
      const id   = doBinding.idFromName(ats);
      const stub = doBinding.get(id);
      await stub.fetch(new Request('https://stat-internal/init', { method: 'POST' }));
      const count = companies.filter(c => c.ats === ats).length;
      registry[key] = {
        name: `${ats} platform DO`, ats, type: 'platform',
        companyCount: count, startedAt: new Date().toISOString(),
      };
      spawned++;
      console.log(`[STAT] ${ats} platform DO started (${count} companies)`);
    } catch (e) {
      console.error(`[STAT] Failed to start ${ats} DO:`, e.message);
    }
  }

  if (spawned > 0) await saveDoRegistry(env, registry);

  // Bootstrap SalaryInferenceDO
  if (spawned > 0 || Object.keys(registry).filter(k => k.startsWith('platform:')).length === 0) {
    try {
      const r = await bootstrapSalaryDO(env);
      console.log('[STAT] Salary bootstrap:', JSON.stringify(r));
    } catch (e) {
      console.warn('[STAT] Salary bootstrap failed (non-critical):', e.message);
    }
  }

  // Bootstrap BatchPollerDO
  if (!registry['batch:main'] && BATCH_WATCHLIST.length > 0) {
    try {
      const id   = env.BATCH_POLLER.idFromName('batch-main');
      const stub = env.BATCH_POLLER.get(id);
      await stub.fetch(new Request('https://stat-internal/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list: 'batch_watchlist' }),
      }));
      registry['batch:main'] = {
        name: 'BatchPollerDO', type: 'batch',
        listSize: BATCH_WATCHLIST.length, startedAt: new Date().toISOString(),
      };
      await saveDoRegistry(env, registry);
      console.log(`[STAT] BatchPollerDO started — ${BATCH_WATCHLIST.length} companies`);
    } catch (e) {
      console.warn('[STAT] BatchPollerDO bootstrap failed (non-critical):', e.message);
    }
  }

  return { companies, registry, spawned };
}


// ─────────────────────────────────────────────────────────────────────────────
// HIRINGCAFE WIDE-NET SCRAPE
// Catches employers not in the DO watchlist.
// On a new company match, adds them to the watchlist and spawns a DO.
// ─────────────────────────────────────────────────────────────────────────────
async function runHiringCafeScrape(env) {
  // Load profile-generated custom keywords for contextual matching
  let hcCustomKeywords = null;
  try {
    const ckRaw = await storeGet(getStatStore(env), 'custom_keywords');
    if (ckRaw) hcCustomKeywords = JSON.parse(ckRaw).keywords || null;
  } catch {}

  // ── TIME-AWARE ADAPTIVE FREQUENCY ────────────────────────────────────────
  // Mirrors the same time-aware schedule as platform DO polling (config.js).
  // Research basis: Tuesday peak (ZipRecruiter 10M jobs), 6-10am ET prime
  // window (TalentWorks: 89% more responses), 48hr application window (OpteroAI).
  //
  // Backoff logic (two dimensions):
  //   1. SIGNAL: 1+ matches last run → use fast interval (active feed)
  //              0 matches last run → use slow interval (feed unchanged)
  //   2. TIME:   mirrors getPollingInterval() windows from config.js
  //              Peak window (Mon-Fri 6-10am ET) → min backoff 1min
  //              Active hours (Mon-Fri 10am-4pm ET) → min backoff 2min
  //              Declining (Mon-Fri 4-7pm ET) → min backoff 5min
  //              Dead zone (overnight, Sat) → min backoff 20min
  //              Sun 6am-4pm → min backoff 10min
  //              Sun 4pm-midnight → min backoff 5min (Monday pre-posts)
  //
  // Result: BR runs fast when jobs are actually being posted,
  //         slow when nothing is happening — aligns cost with signal.
  function getHCBackoffMs(lastMatchCount) {
    const nowET = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
    );
    const day  = nowET.getDay();
    const hour = nowET.getHours();

    let slowMs; // backoff when 0 matches
    let fastMs; // backoff when 1+ matches

    if (day === 6) {
      // Saturday — dead zone all day
      slowMs = 20 * 60_000; fastMs = 10 * 60_000;
    } else if (day === 0) {
      // Sunday
      if (hour >= 16) {
        slowMs = 5 * 60_000; fastMs = 2 * 60_000;  // Monday pre-posts
      } else if (hour >= 6) {
        slowMs = 10 * 60_000; fastMs = 4 * 60_000; // light activity
      } else {
        slowMs = 20 * 60_000; fastMs = 10 * 60_000; // dead zone
      }
    } else {
      // Monday–Friday
      if (hour >= 6 && hour < 10) {
        slowMs = 2 * 60_000; fastMs = 60_000;       // peak window ★
      } else if (hour >= 10 && hour < 16) {
        slowMs = 4 * 60_000; fastMs = 2 * 60_000;   // active hours
      } else if (hour >= 16 && hour < 19) {
        slowMs = 8 * 60_000; fastMs = 4 * 60_000;   // declining
      } else {
        slowMs = 20 * 60_000; fastMs = 10 * 60_000; // overnight dead zone
      }
    }

    return lastMatchCount > 0 ? fastMs : slowMs;
  }

  try {
    const hcStateRaw = await storeGet(getStatStore(env), 'hc_br_state');
    if (hcStateRaw) {
      const hcState = JSON.parse(hcStateRaw);
      const msSinceRun = Date.now() - (hcState.lastRunAt || 0);
      const backoffMs = getHCBackoffMs(hcState.lastMatchCount || 0);
      if (msSinceRun < backoffMs) {
        console.log(`[STAT HC] Backoff — ${Math.round(msSinceRun/1000)}s since last run, ` +
                    `${hcState.lastMatchCount} matches, window=${backoffMs/1000}s`);
        return 0;
      }
    }
  } catch {}

  const seenIds = await loadSeenIds(env);
  const newMatches = [];
  const unmatchedJobsHC = [];  // env-filtered HC jobs with no keyword match — Browse capture
  const seenThisRun = new Set();

  // ── HIRINGCAFE SEARCH — searchState SSR (confirmed 2026-06-08) ─────────────
  // ?searchState= is processed server-side: returns keyword-filtered hits with
  // v5_processed_job_data and enriched_company_data included in ssrHits.
  // ssrPageSize=40; we fetch page 0 + page 1 when ssrIsLastPage=false.
  // BR path retained as dead code — searchState SSR is simpler and sufficient.
  // ─────────────────────────────────────────────────────────────────────────
  for (const envType of HIRINGCAFE.environments) {
    let jobs = null;
    // Rotate through Epic search terms — each term targets the HC index differently
    // searchState.searchQuery is processed against title + description + v5 fields
    const hcTerms = HIRINGCAFE.search_terms.filter(t =>
      t.startsWith('epic') || t.includes('ehr') || t.includes('clarity') ||
      t.includes('informatics') || t.includes('him analyst')
    );
    // Use one term per cron cycle, rotating via timestamp — avoids redundant fetches
    const termIdx = Math.floor(Date.now() / (60_000)) % hcTerms.length;
    const activeTerm = hcTerms[termIdx] ?? 'epic analyst';
    try {
      jobs = await fetchHiringCafe(activeTerm, envType);
      if (jobs.length > 0) {
        console.log(`[STAT HC] ${jobs.length} results for "${activeTerm}" ${envType}`);
      }
    } catch (e) {
      console.warn('[STAT HC] fetchHiringCafe failed:', e.message);
      jobs = [];
    }
    for (const job of jobs) {
      if (seenThisRun.has(job.id) || seenIds.has(job.id)) {
        seenIds.add(job.id);
        seenThisRun.add(job.id);
        continue;
      }
      seenThisRun.add(job.id);
      seenIds.add(job.id);

      if (job.ghostFlag === 'suppress') continue;
      // Browse capture for HiringCafe path (Rule 8 — all paths capture unmatched)
      if (passesEnvFilter(job) && !matchJob(job)) {
        unmatchedJobsHC.push(job);
      }
      if (!passesEnvFilter(job)) continue;
      const match = matchJob(job, hcCustomKeywords);
      if (!match) continue;

      job.matchedKeyword = match.matchedKw;

      // ── Liveness check ────────────────────────────────────────────────────
      // HEAD request to job.url (ATS apply_url) — confirms posting still live.
      // 4xx → dead (skip). timeout/5xx → unknown (let through).
      const liveness = await checkJobLiveness(job);
      if (liveness === 'dead') continue;
      job.liveness = liveness;

      // ── Salary enrichment ─────────────────────────────────────────────────
      await enrichJobWithSalary(job, match, env);

      const adjustedPriority = companyAwarePriority(job, match);
      const adjustedMatch = adjustedPriority !== match.priority
        ? { ...match, priority: adjustedPriority }
        : match;
      job._matchGroup = adjustedMatch.label;
      newMatches.push({ job, match: adjustedMatch });

      await maybeAddOrPromoteCompany(env, job);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  await saveSeenIds(env, seenIds);

  if (unmatchedJobsHC.length > 0) {
    await saveUnmatchedJobs(getStatStore(env), unmatchedJobsHC);
  }

  // Update adaptive frequency state
  try {
    await storeSet(getStatStore(env), 'hc_br_state', JSON.stringify({
      lastRunAt: Date.now(),
      lastMatchCount: newMatches.length,
    }));
  } catch {}

  if (newMatches.length > 0) {
    // ── Description fetch + MD scoring (parity with platform-do) ─────────
    // enrichDescriptions handles HC via fetchPlainDescription (hiring.cafe/job/{id})
    // — same path as fetchHcDescription but batched with 3-concurrent + HTML strip.
    await enrichDescriptions(newMatches, env);

    // Maryland eligibility scoring — runs after description is populated
    const mdFiltered = [];
    for (const m of newMatches) {
      const suppressed = applyMarylandScore(m.job, null);
      if (!suppressed) mdFiltered.push(m);
    }
    newMatches.length = 0;
    newMatches.push(...mdFiltered);

    // Gemini fit scoring
    const profile = await loadProfile(env);
    if (profile && env.GEMINI_KEY) {
      await scoreBatch(newMatches, profile, env.GEMINI_KEY);
    }
    console.log(`[STAT HC] ${newMatches.length} new HiringCafe matches`);
    await appendLog(getStatStore(env), {
      type: 'hc_poll', ats: 'hiringcafe', newMatches: newMatches.length,
    });
    await dispatchAlerts(env, newMatches);
    // ── saveRecentMatches — makes HC matches visible in Matches tab ───────
    await saveRecentMatches(getStatStore(env), newMatches);
  }

  return newMatches.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-DISCOVER + PROMOTE
// First match: track company in match_counts KV.
// After LEARNING.promote_after_matches matches: spawn a persistent DO.
// This makes the watchlist self-building — high-signal employers graduate
// from wide-net tracking to 30-second direct ATS polling automatically.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// CRON HANDLER — runs every minute
// 1. Bootstrap DOs if not already running
// 2. Run HiringCafe wide-net scrape
// ─────────────────────────────────────────────────────────────────────────────
async function handleScheduled(env) {
  // Bootstrap DOs (idempotent — skips already-running companies)
  await bootstrapDOs(env);

  // Auto-fetch resume from OneDrive if configured and profile missing or stale
  // Runs on every cron tick but only fetches when needed (profile absent or >7 days old)
  if (env.ONEDRIVE_RESUME_URL) {
    try {
      const existing = await loadProfile(env).catch(() => null);
      const fetchedAt = existing?._fetchedAt ? new Date(existing._fetchedAt) : null;
      const stale = !fetchedAt || (Date.now() - fetchedAt.getTime()) > 7 * 24 * 60 * 60 * 1000;
      if (!existing || stale) {
        console.log('[STAT resume] fetching from OneDrive...');
        const profile = await fetchResumeFromOneDrive(env);
        if (profile) {
          profile._fetchedAt = new Date().toISOString();
          await saveProfile(env, profile);
        }
      }
    } catch (e) {
      console.warn('[STAT resume] cron refresh failed:', e.message);
    }
  }

  // Wide-net HiringCafe scrape
  await runHiringCafeScrape(env);
  // Auto-refresh salary caches on schedule — no manual intervention required
  await maybeRefreshSalaryCaches(env);

  // jobhive CSV scan — runs once per hour, not every minute
  // Streams jobhive's ATS slices to find Epic roles at companies outside the seed list.
  // Discovered companies auto-promoted via maybeAddOrPromoteCompany() (healthcare gate).
  await maybeRunJobhiveScan(env);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOBHIVE CSV SCAN
// Streams jobhive's ATS CSV slices to discover Epic roles at unknown companies.
// Runs at most once per hour. On match, calls maybeAddOrPromoteCompany()
// with gate:'strict' — only health systems and Epic consulting firms promoted.
//
// ATS slices scanned each cycle (ordered by relevance and size):
//   workday (680K rows, 50MB scan), taleo (1K rows, full),
//   icims (116K rows, 20MB scan) — Greenhouse/Lever/Ashby direct polled already
//
// The scan is additive to direct polling — it catches roles at companies
// STAT has never heard of. Once discovered, they get promoted to direct DO
// polling (which gives real-time alerts) after 2 matches.
// ─────────────────────────────────────────────────────────────────────────────
// Epic-specific terms to match against title + description.
// Intentionally more specific than 'epic' alone — avoids false positives like
// "epic growth", "an epic adventure", generic uses of the word.
// Mirrors WATCH_GROUPS P1 keywords but filtered to terms that appear in
// job descriptions at health systems and consulting firms.
const JOBHIVE_EPIC_TERMS = [
  // Module names — most specific, highest precision
  'epic ambulatory', 'epiccare', 'epic cadence', 'epic clindoc', 'epic willow',
  'epic optime', 'epic stork', 'epic beacon', 'epic radiant', 'epic cupid',
  'epic resolute', 'epic cogito', 'epic orders', 'epic him', 'epic identity',
  'epic inpatient', 'epic myChart', 'epic tapestry', 'epic grand central',
  // Role signals
  'epic analyst', 'epic application analyst', 'epic build', 'epic implementation',
  'epic go-live', 'epic go live', 'ehr analyst', 'ehr application analyst',
  'clarity sql', 'clinical informatics analyst', 'health informatics analyst',
  // Certification signals — appear in descriptions even when title is generic
  'within epic', 'epic certification', 'epic certified', 'epic training',
  'epic ecosystem', 'epic upgrade', 'epic optimization',
  // EHR-adjacent — high specificity in healthcare IT context
  'epic ehr', 'epic emr', 'epic system', 'epic systems analyst',
];

function matchesEpicTerms(text, returnTerm = false) {
  const lower = text.toLowerCase();
  if (returnTerm) {
    return JOBHIVE_EPIC_TERMS.find(t => lower.includes(t)) ?? null;
  }
  return JOBHIVE_EPIC_TERMS.some(t => lower.includes(t));
}

// Quote-aware CSV row splitter for streaming chunks.
// Returns { rows: string[], carry: string, carryInQuote: bool }.
// carry + carryInQuote must be threaded across ReadableStream chunks so that
// partial rows and open quotes spanning chunk boundaries are handled correctly.
// Handles: embedded commas, embedded newlines, escaped quotes ("") inside quoted fields.
function splitCSVRows(chunk, carry, carryInQuote) {
  let buf = carry;
  let inQ = carryInQuote;
  const rows = [];
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (c === '"') {
      if (inQ && chunk[i + 1] === '"') { buf += '"'; i++; } // escaped quote ""
      else inQ = !inQ;
      buf += c;
    } else if (c === '\n' && !inQ) {
      if (buf.trim()) rows.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  return { rows, carry: buf, carryInQuote: inQ };
}

function parseCSVRow(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      fields.push(cur.replace(/^"|"$/g, '')); cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur.replace(/^"|"$/g, ''));
  return fields;
}

function cleanDesc(raw) {
  return (raw || '')
    .replace(/\\r\\n/g, ' ').replace(/\\n/g, ' ').replace(/\\r/g, ' ')
    .replace(/&#?[a-zA-Z0-9]+;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const JOBHIVE_SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const JOBHIVE_SLICES = [
  { ats: 'workday',  maxBytes: 50 * 1024 * 1024 },  // 50MB → ~430K rows
  { ats: 'taleo',    maxBytes: 10 * 1024 * 1024 },  // 10MB → full slice
  { ats: 'icims',    maxBytes: 20 * 1024 * 1024 },  // 20MB → ~140K rows
];

async function maybeRunJobhiveScan(env) {
  try {
    const store = getStatStore(env);
    const lastRaw = await storeGet(store, 'jobhive_scan_last');
    const lastRun = lastRaw ? parseInt(lastRaw) : 0;
    if (Date.now() - lastRun < JOBHIVE_SCAN_INTERVAL_MS) return; // throttle
    await storeSet(store, 'jobhive_scan_last', String(Date.now()));
  } catch { return; }

  let totalMatches = 0;
  for (const { ats, maxBytes } of JOBHIVE_SLICES) {
    try {
      const csvUrl = `https://storage.stapply.ai/jobhive/v1/${ats}/jobs.csv`;
      const res = await fetch(csvUrl, {
        headers: {
          'User-Agent': 'STAT-job-watcher/1.0',
          'Range': `bytes=0-${maxBytes - 1}`,
        },
      });
      if (!res.ok && res.status !== 206) continue;
      if (!res.body) continue;

      const decoder = new TextDecoder();
      const reader  = res.body.getReader();
      let   carry        = '';    // incomplete row carried between chunks
      let   carryInQuote = false; // open-quote state at chunk boundary
      let   header  = null;
      let   isFirst = true;

      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) { done = true; }
        // csvRows() — replaced with splitCSVRows (quote-aware, carries inQ state)
        const text = chunk.done ? '' : decoder.decode(chunk.value, { stream: true });
        const { rows, carry: newCarry, carryInQuote: newInQ } = splitCSVRows(text, carry, carryInQuote);
        carry = newCarry; carryInQuote = newInQ;

        for (const line of rows) {
          if (!line.trim()) continue;
          if (isFirst) { header = parseCSVRow(line); isFirst = false; continue; }
          if (!header) continue;

          const f          = parseCSVRow(line);
          const title      = f[1] || '';
          const company    = f[2] || '';
          const location   = f[5] || '';
          const isRemote   = f[6] === 'true' || f[6] === '1' || f[6] === 'True';
          const applyUrl   = f[18] || f[0] || '';
          const countryIso = (f[21] || '').toUpperCase();
          const description = cleanDesc(f[15]);

          if (countryIso && countryIso !== 'US' && countryIso !== 'USA') continue;
          const usLocale = isRemote ||
            /\b[A-Z]{2}\b/.test(location) ||
            location.toLowerCase().includes('remote');
          if (!usLocale) continue;

          const haystack = title + ' ' + description;
          if (!matchesEpicTerms(haystack)) continue;

          totalMatches++;

          // ── First-alert (open item #6) ──────────────────────────────────
          // Previously: discovery only via maybeAddOrPromoteCompany.
          // Now: build job object, run full match pipeline, fire P3 alert.
          // P3 = email only (no Pushover noise for discovery-sourced jobs).
          // seen_ids check prevents re-alerting if DO picks up same job later.
          const jobId = applyUrl || `jobhive:${ats}:${company}:${title}`.slice(0, 80);
          try {
            const seenIds = await loadSeenIds(env);
            if (!seenIds.has(jobId)) {
              const job = {
                id:           jobId,
                title,
                company,
                location,
                environment:  isRemote ? 'remote' : location.toLowerCase().includes('hybrid') ? 'hybrid' : '',
                salary:       null,
                salaryRaw:    null,
                url:          applyUrl,
                postedAt:     null,
                daysAgo:      null,
                ghostFlag:    null,
                matchedKeyword: null,
                atsSource:    ats,   // 'workday' | 'taleo' | 'icims'
                description,
              };

              if (passesEnvFilter(job)) {
                const match = matchJob(job) ?? {
                  group: WATCH_GROUPS[2],
                  priority: 3,
                  label: 'Jobhive Discovery',
                  matchedKw: matchesEpicTerms(haystack, true),
                };
                job.matchedKeyword = match.matchedKw;

                await enrichJobWithSalary(job, match, env);
                applyMarylandScore(job, null);

                seenIds.add(jobId);
                await saveSeenIds(env, seenIds);

                const adjustedPriority = companyAwarePriority(job, match);
                const adjustedMatch = adjustedPriority !== match.priority
                  ? { ...match, priority: adjustedPriority } : match;
                job._matchGroup = adjustedMatch.label;

                await dispatchAlerts(env, [{ job, match: adjustedMatch }]);
                await saveRecentMatches(getStatStore(env), [{ job, match: adjustedMatch }]);
                console.log(`[STAT jobhive] first-alert: ${title} @ ${company}`);
              }
            }
          } catch (e) {
            console.warn(`[STAT jobhive] first-alert error:`, e.message);
          }

          await maybeAddOrPromoteCompany(env, {
            url: applyUrl, company, title, location, description,
          }, { gate: 'strict' }).catch(() => {});
        }
        if (chunk.done) break;
      }
      await reader.cancel();

      console.log(`[STAT jobhive] ${ats}: scanned, ${totalMatches} epic matches total`);
    } catch (e) {
      console.warn(`[STAT jobhive] ${ats} scan error:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500)); // polite delay between slices
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO SALARY CACHE REFRESH
// Runs every cron tick but only refreshes when caches are stale.
// LCA: quarterly (90 days) — DOL releases new data every quarter
// BLS: annual (365 days) — BLS OEWS publishes in May each year
// Both refreshes are non-blocking — a failure never blocks the cron cycle.
// ─────────────────────────────────────────────────────────────────────────────
async function maybeRefreshSalaryCaches(env) {
  try {
    const id   = env.SALARY_INFERENCE.idFromName('salary-inference');
    const stub = env.SALARY_INFERENCE.get(id);

    const statusRes = await stub.fetch(new Request('https://stat-salary/status'));
    const { blsDate, lcaDate } = await statusRes.json();

    const now         = Date.now();
    const BLS_TTL_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year
    const LCA_TTL_MS  =  90 * 24 * 60 * 60 * 1000; // 90 days (quarterly)

    const blsStale = !blsDate || (now - new Date(blsDate).getTime()) > BLS_TTL_MS;
    const lcaStale = !lcaDate || (now - new Date(lcaDate).getTime()) > LCA_TTL_MS;

    if (blsStale) {
      console.log('[STAT cron] BLS cache stale — refreshing');
      stub.fetch(new Request('https://stat-salary/refresh-bls', { method: 'POST' }))
        .catch(e => console.warn('[STAT cron] BLS refresh error:', e.message));
    }

    if (lcaStale) {
      console.log('[STAT cron] LCA cache stale — refreshing');
      stub.fetch(new Request('https://stat-salary/refresh-lca', { method: 'POST' }))
        .catch(e => console.warn('[STAT cron] LCA refresh error:', e.message));
    }
  } catch (e) {
    // Non-critical — salary DO may not be bootstrapped yet
    console.warn('[STAT cron] Salary cache check skipped:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HANDLER — operational endpoints
// ─────────────────────────────────────────────────────────────────────────────
async function handleFetch(request, env) {
  const url = new URL(request.url);

  // GET /ui — HTML dashboard (served inline from ui.html)
  if (url.pathname === '/ui' && request.method === 'GET') {
    return new Response(UI_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  }

  // GET / — redirect browsers to /ui, return JSON for API clients
  if (url.pathname === '/' && request.method === 'GET') {
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/html')) {
      return Response.redirect(new URL('/ui', request.url).toString(), 302);
    }
    const registry = await loadDoRegistry(env);
    const seenIds  = await loadSeenIds(env);
    const companies = await loadCompanyList(env) ?? [];
    const profile = await loadProfile(env);

    // Fetch salary cache status non-blocking (failure just means no salary data yet)
    let salaryStatus = { peerCount: 0, lcaCount: 0, blsDate: null, lcaDate: null };
    try {
      const salId = env.SALARY_INFERENCE.idFromName('salary-inference');
      const salStub = env.SALARY_INFERENCE.get(salId);
      // 3s timeout — DO may not be bootstrapped yet, must not hang GET /
      const salRes = await Promise.race([
        salStub.fetch(new Request('https://stat-salary/status')),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      salaryStatus = await salRes.json();
    } catch { /* not yet bootstrapped or timed out */ }

    const now = Date.now();
    const blsAge = salaryStatus.blsDate
      ? Math.floor((now - new Date(salaryStatus.blsDate).getTime()) / 86_400_000) + 'd'
      : 'never';
    const lcaAge = salaryStatus.lcaDate
      ? Math.floor((now - new Date(salaryStatus.lcaDate).getTime()) / 86_400_000) + 'd'
      : 'never';

    return json({
      name: 'STAT Job Watcher',
      version: '2.0.0',
      activeDOs: Object.keys(registry).length,
      watchedCompanies: companies.length,
      batchWatchlist: BATCH_WATCHLIST.length,
      totalMonitored: companies.length + BATCH_WATCHLIST.length,
      seenJobIds: seenIds.size,
      resumeProfile: profile ? `${profile.name || 'stored'} · ${profile.headline || ''}` : null,
      fitScoring: profile && env.GEMINI_KEY ? 'active' : profile ? 'profile stored — add ANTHROPIC_API_KEY' : 'disabled (no profile stored)',
      salary: {
        peers: salaryStatus.peerCount,
        lcaRecords: salaryStatus.lcaCount,
        blsCacheAge: blsAge,
        lcaCacheAge: lcaAge,
        status: salaryStatus.lcaCount > 0 && salaryStatus.blsDate
          ? 'active' : salaryStatus.lcaCount > 0
          ? 'bls-pending' : 'cold-start',
      },
      endpoints: {
        'GET /':               'This status overview',
        'POST /trigger':       'Run HiringCafe scrape now',
        'POST /bootstrap':     'Spawn DOs for all companies',
        'GET /companies':      'List all watched companies',
        'POST /companies':     'Add a company (body: {name,ats,token,url?})',
        'GET /platform/:ats/status': 'Status of a platform DO (greenhouse/lever/etc.)',
        'GET /salary-status':  'Salary DO status',
        'POST /salary-refresh':'Re-fetch salary caches',
        'GET /profile':        'Get stored resume profile',
        'POST /profile':       'Store resume profile (JSON from resume-matcher)',
        'DELETE /profile':     'Remove stored profile',
        'GET /learning':       'Auto-discovered companies + promotion status',
        'GET /batch-status':   'BatchPollerDO cycle status + cursor position',
        'GET /br-test?url=&ats=': 'Browser Rendering diagnostic — test against iCIMS/Taleo SPAs',
        'POST /reset-seen':    'Clear seen job IDs',
        'POST /reset-all':     'Nuclear reset',
      },
    });
  }

  // POST /trigger — manual HiringCafe scrape
  if (url.pathname === '/trigger' && request.method === 'POST') {
    const count = await runHiringCafeScrape(env);
    return json({ ok: true, newMatches: count, time: new Date().toISOString() });
  }

  // GET /workday-probe — rate limit floor probe for Workday API
  // Tests a single tenant at decreasing intervals and returns results as JSON.
  // Usage: GET /workday-probe?tenant=jhhs&host=jhhs.wd5.myworkdayjobs.com&slug=JHH_External_Positions
  // Takes ~60s to run (6 rounds with sleep gaps).
  if (url.pathname === '/workday-probe' && request.method === 'GET') {
    const tenant = url.searchParams.get('tenant');
    const host   = url.searchParams.get('host');
    const slug   = url.searchParams.get('slug');
    if (!tenant || !host || !slug) {
      return json({ error: 'tenant, host, slug required' }, 400);
    }
    const apiUrl = `https://${host}/wday/cxs/${tenant}/${slug}/jobs`;
    const body = JSON.stringify({
      appliedFacets: {}, limit: 5, offset: 0,
      searchText: 'epic ehr',
    });
    const origin = `https://${host}`;
    const referer = `https://${host}/en-US/${slug}`;
    const hdrs = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; STAT/1.0)',
      // Workday /wday/cxs/ API requires same-origin headers — 422 without them
      'Origin':  origin,
      'Referer': referer,
    };
    const gaps = [0, 30, 10, 5, 2, 1];
    const results = [];
    for (const gap of gaps) {
      if (gap > 0) await new Promise(r => setTimeout(r, gap * 1000));
      const start = Date.now();
      try {
        const res = await fetch(apiUrl, { method: 'POST', headers: hdrs, body });
        const elapsed = Date.now() - start;
        let jobCount = 0;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          jobCount = data.jobPostings?.length ?? 0;
        }
        results.push({ gap, http: res.status, elapsed, jobs: jobCount,
          verdict: res.ok && jobCount > 0 ? 'OK'
                 : res.ok && jobCount === 0 ? 'SILENT_THROTTLE'
                 : res.status === 429 ? 'RATE_LIMITED' : 'ERROR' });
      } catch (e) {
        results.push({ gap, http: 'ERR', elapsed: Date.now() - start, verdict: 'ERROR', error: e.message });
      }
    }
    const anyThrottle = results.some(r => r.verdict !== 'OK');
    const lowestSafeGap = results.filter(r => r.verdict === 'OK').reduce((min, r) => Math.min(min, r.gap), 30);
    return json({ tenant, results, anyThrottle, lowestSafeGapSeconds: lowestSafeGap });
  }

  // POST /regenerate-keywords — regenerate profile-driven keyword list from stored profile
  if (url.pathname === '/regenerate-keywords' && request.method === 'POST') {
    const profile = await loadProfile(env).catch(() => null);
    if (!profile) return json({ error: 'No profile stored — upload resume first' }, 404);
    if (!env.GEMINI_KEY) return json({ error: 'GEMINI_KEY not configured' }, 503);
    const keywords = await generateAndStoreKeywords(profile, env);
    if (!keywords) return json({ error: 'Keyword generation failed' }, 500);
    return json({ ok: true, keywords, generatedFrom: profile.headline });
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

  // GET /salary-status — salary inference DO status
  if (url.pathname === '/salary-status' && request.method === 'GET') {
    try {
      const id = env.SALARY_INFERENCE.idFromName('salary-inference');
      const stub = env.SALARY_INFERENCE.get(id);
      const res = await stub.fetch(new Request('https://stat-salary/status'));
      return res;
    } catch (e) {
      return json({ error: 'SALARY_INFERENCE not available: ' + e.message });
    }
  }

  // POST /salary-refresh — manually refresh BLS + LCA caches
  if (url.pathname === '/salary-refresh' && request.method === 'POST') {
    try {
      const result = await bootstrapSalaryDO(env);
      return json({ ok: true, ...result });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

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

  // GET /jobhive-scan?ats=workday&maxBytes=52428800&limit=500
  // Streams a jobhive CSV slice via HTTP range request, finds Epic-matching jobs.
  // O(1) memory: processes one line at a time via ReadableStream + TextDecoder.
  // Returns matched jobs for auto-discovery and alerting.
  //
  // CSV column layout (schema v2.0, verified 2026-06-07):
  //   0:url  1:title  2:company  3:ats_type  4:ats_id  5:location
  //   6:is_remote  7:salary_min  8:salary_max  9:salary_currency
  //   10:salary_period  11:salary_summary  12:employment_type
  //   13:department  14:team  15:description  16:posted_at
  //   17:requisition_id  18:apply_url  19:commitment  20:raw  21:country_iso
  if (url.pathname === '/jobhive-scan' && request.method === 'GET') {
    const ats      = url.searchParams.get('ats') || 'workday';
    const maxBytes = Math.min(parseInt(url.searchParams.get('maxBytes') || String(50 * 1024 * 1024)), 100 * 1024 * 1024);
    const limit    = Math.min(parseInt(url.searchParams.get('limit') || '500'), 2000);
    const csvUrl   = `https://storage.stapply.ai/jobhive/v1/${ats}/jobs.csv`;

    try {
      const res = await fetch(csvUrl, {
        headers: {
          'User-Agent': 'STAT-job-watcher/1.0',
          'Range': `bytes=0-${maxBytes - 1}`,
        },
      });
      if (!res.ok && res.status !== 206) return json({ error: `HTTP ${res.status}` }, 502);
      if (!res.body) return json({ error: 'no response body' }, 502);

      // Stream CSV line by line — O(1) memory
      const decoder = new TextDecoder();
      const reader  = res.body.getReader();
      const matches = [];
      let   carry        = '';
      let   carryInQuote = false;
      let   header  = null;
      let   isFirst = true;
      let   rowCount = 0;
      let   done    = false;

      while (!done && matches.length < limit) {
        const chunk = await reader.read();
        if (chunk.done) { done = true; }

        const text2 = chunk.done ? '' : decoder.decode(chunk.value, { stream: true });
        const { rows: rows2, carry: newCarry2, carryInQuote: newInQ2 } = splitCSVRows(text2, carry, carryInQuote);
        carry = newCarry2; carryInQuote = newInQ2;

        for (const line of rows2) {
          if (!line.trim()) continue;
          if (isFirst) { header = parseCSVRow(line); isFirst = false; continue; }
          if (!header) continue;
          rowCount++;

          const f          = parseCSVRow(line);
          const title      = f[1]  || '';
          const company    = f[2]  || '';
          const atsType    = f[3]  || '';
          const atsId      = f[4]  || '';
          const location   = f[5]  || '';
          const isRemote   = f[6]  === 'true' || f[6] === '1' || f[6] === 'True';
          const salMin     = parseFloat(f[7]) || null;
          const salMax     = parseFloat(f[8]) || null;
          const salCur     = f[9]  || '';
          const postedAt   = f[16] || '';
          const applyUrl   = f[18] || f[0] || '';
          const countryIso = (f[21] || '').toUpperCase();
          const description = cleanDesc(f[15]);

          if (countryIso && countryIso !== 'US' && countryIso !== 'USA') continue;
          const usLocale = isRemote ||
            /\b[A-Z]{2}\b/.test(location) ||
            location.toLowerCase().includes('remote');
          if (!usLocale) continue;

          const haystack = title + ' ' + description;
          if (!matchesEpicTerms(haystack)) continue;

          const salStr = (salMin && salCur === 'USD')
            ? (salMax ? `$${Math.round(salMin/1000)}k–$${Math.round(salMax/1000)}k` : `$${Math.round(salMin/1000)}k+`)
            : null;

          matches.push({
            id:          `jobhive:${ats}:${atsId || f[17] || rowCount}`,
            title, company,
            location:    location.replace(/\{[^}]+\}/g, '').trim(),
            atsType, atsId, isRemote,
            salary:      salStr,
            postedAt,
            url:         applyUrl,
            description: description.slice(0, 800) || null,
            source:      'jobhive-csv',
          });
        }
        if (chunk.done) break;
      }
      await reader.cancel();

      return json({
        ats, rowsScanned: rowCount, matchCount: matches.length,
        bytesRequested: maxBytes, truncated: !done,
        matches: matches.slice(0, limit),
      });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // GET /jobhive-sample?ats=workday&bytes=8192 — first N bytes of a slice CSV
  // Used to inspect CSV structure and column layout before building the full scan.
  if (url.pathname === '/jobhive-sample' && request.method === 'GET') {
    const ats   = url.searchParams.get('ats') || 'workday';
    const bytes = Math.min(parseInt(url.searchParams.get('bytes') || '8192'), 65536);
    const csvUrl = `https://storage.stapply.ai/jobhive/v1/${ats}/jobs.csv`;
    try {
      const res = await fetch(csvUrl, {
        headers: {
          'User-Agent': 'STAT-job-watcher/1.0',
          'Range': `bytes=0-${bytes - 1}`,
        },
      });
      if (!res.ok && res.status !== 206) return json({ error: `HTTP ${res.status}` }, 502);
      const text = await res.text();
      // Return first 5 complete lines for structure inspection
      const lines = text.split('\n').slice(0, 6);
      return json({
        ats, bytes_requested: bytes, status: res.status,
        content_range: res.headers.get('content-range'),
        encoding: res.headers.get('content-encoding'),
        lines,
      });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // GET /jobhive-manifest — fetch jobhive manifest + slice details
  if (url.pathname === '/jobhive-manifest' && request.method === 'GET') {
    try {
      const manifestRes = await fetch('https://storage.stapply.ai/jobhive/v1/manifest.json',
        { headers: { 'User-Agent': 'STAT-job-watcher/1.0' } });
      if (!manifestRes.ok) return json({ error: `manifest ${manifestRes.status}` }, 502);
      const manifest = await manifestRes.json();
      const { generated_at, stats, by_ats, by_date } = manifest;

      const sliceInfo = (key) => {
        const e = by_ats?.[key];
        if (!e) return null;
        return {
          rows:     e.rows,
          size_mb:  +(e.size_bytes/1e6).toFixed(1),
          csv:      e.csv    ?? null,
          parquet:  e.parquet ?? null,
          sha256:   e.sha256 ?? null,
        };
      };

      // by_date: check last 3 dates for delta slices
      const dateKeys = Object.keys(by_date ?? {}).sort().slice(-3);
      const recentDeltas = dateKeys.map(d => ({
        date: d,
        rows: by_date[d].rows,
        size_mb: +(by_date[d].size_bytes/1e6).toFixed(2),
        csv: by_date[d].csv ?? null,
        parquet: by_date[d].parquet ?? null,
      }));

      // Range request probe on Workday CSV
      let rangeSupported = false;
      try {
        const rangeRes = await fetch(by_ats?.workday?.csv ?? '', {
          method: 'HEAD',
          headers: { 'User-Agent': 'STAT-job-watcher/1.0' },
        });
        rangeSupported = rangeRes.headers.get('accept-ranges') === 'bytes';
      } catch {}

      return json({
        generated_at,
        stats,
        range_supported: rangeSupported,
        slices: {
          workday:        sliceInfo('workday'),
          taleo:          sliceInfo('taleo'),
          icims:          sliceInfo('icims'),
          successfactors: sliceInfo('successfactors'),
          greenhouse:     sliceInfo('greenhouse'),
          lever:          sliceInfo('lever'),
          ashby:          sliceInfo('ashby'),
        },
        recent_deltas: recentDeltas,
      });
    } catch (e) {
      return json({ error: e.message }, 500);
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
    };
    const binding = PLATFORM_MAP[ats];
    if (!binding || !env[binding]) return json({ error: `Unknown platform: ${ats}` }, 404);
    const id   = env[binding].idFromName(ats);
    const stub = env[binding].get(id);
    const res  = await stub.fetch(new Request('https://stat-internal/status'));
    return res;
  }

  // GET /batch-status — BatchPollerDO status
  if (url.pathname === '/batch-status' && request.method === 'GET') {
    try {
      const id   = env.BATCH_POLLER.idFromName('batch-main');
      const stub = env.BATCH_POLLER.get(id);
      const res  = await stub.fetch(new Request('https://stat-internal/status'));
      return res;
    } catch (e) {
      return json({ error: 'BatchPollerDO not available: ' + e.message });
    }
  }

  // GET /logs — recent alarm-cycle log entries for diagnostic visibility
  // Shows: per-ATS alarm results, Workday BR intercept success/fail, error counts
  // Query params: ?limit=N (default 50, max 200) ?ats=workday (filter by ATS)
  // CI log-check workflow calls this and writes to outbox/ for Claude to read.
  if (url.pathname === '/logs' && request.method === 'GET') {
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const qAts   = url.searchParams.get('ats');
    let entries  = await readLog(getStatStore(env), 200);
    if (qAts) entries = entries.filter(e => e.ats === qAts);
    entries = entries.slice(0, limit);
    return json(entries);
  }

  // GET /jobs — recent keyword-matched jobs (rolling 200)
  // Query params: ?priority=1 ?ats=greenhouse ?q=epic ?limit=50
  if (url.pathname === '/jobs' && request.method === 'GET') {
    const matches = await loadRecentMatches(getStatStore(env));
    let filtered = matches;

    const qPriority = url.searchParams.get('priority');
    const qAts      = url.searchParams.get('ats');
    const qSearch   = url.searchParams.get('q')?.toLowerCase();
    const qLimit    = parseInt(url.searchParams.get('limit') || '200', 10);

    if (qPriority) filtered = filtered.filter(m => String(m.match?.priority) === qPriority);
    if (qAts)      filtered = filtered.filter(m => m.job?.atsSource === qAts);
    if (qSearch)   filtered = filtered.filter(m =>
      (m.job?.title || '').toLowerCase().includes(qSearch) ||
      (m.job?.company || '').toLowerCase().includes(qSearch) ||
      (m.job?.description || '').toLowerCase().includes(qSearch)
    );

    filtered = filtered.slice(0, Math.min(qLimit, 200));

    return json({
      ok:    true,
      count: filtered.length,
      total: matches.length,
      jobs:  filtered,
    });
  }

  // POST /feedback — record user action on a matched job
  // Body: { jobId, action } where action is 'applied' | 'skip'
  // Writes feedback back into the matching recent_matches entry.
  // Used by the scoring layer to learn from actual user behavior.
  if (url.pathname === '/feedback' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { jobId, action } = body;
    if (!jobId || !['applied', 'skip'].includes(action)) {
      return json({ error: 'jobId and action (applied|skip) required' }, 400);
    }

    const stub    = getStatStore(env);
    const matches = await loadRecentMatches(stub);
    const idx     = matches.findIndex(m => m.job?.id === jobId);
    if (idx === -1) return json({ error: 'Job not found' }, 404);

    // Write feedback into the match entry
    matches[idx].feedback   = action;
    matches[idx].feedbackAt = new Date().toISOString();

    // Persist
    try {
      await storeSet(stub, 'recent_matches', JSON.stringify(matches));
    } catch (e) {
      return json({ error: 'Store write failed: ' + e.message }, 500);
    }

    console.log(`[STAT feedback] ${action}: ${matches[idx].job?.title} @ ${matches[idx].job?.company}`);
    return json({ ok: true, jobId, action });
  }

  // GET /feedback/summary — recent feedback for scorer context
  // Returns last 50 feedback signals: title, company, action, fitScore
  if (url.pathname === '/feedback/summary' && request.method === 'GET') {
    const matches = await loadRecentMatches(getStatStore(env));
    const signals = matches
      .filter(m => m.feedback)
      .map(m => ({
        title:     m.job?.title || '',
        company:   m.job?.company || '',
        action:    m.feedback,
        fitScore:  m.job?.fitScore ?? null,
        environment: m.job?.environment || '',
        salary:    m.job?.salary || '',
        feedbackAt: m.feedbackAt,
      }))
      .slice(0, 50);
    return json({ ok: true, count: signals.length, signals });
  }

  // GET /browse — env-filtered jobs that didn't match any keyword
  // Useful for manually spotting roles STAT missed. ?ats= ?q= ?limit=
  if (url.pathname === '/browse' && request.method === 'GET') {
    const items = await loadUnmatchedJobs(getStatStore(env));
    let filtered = items;

    const qAts    = url.searchParams.get('ats');
    const qSearch = url.searchParams.get('q')?.toLowerCase();
    const qLimit  = parseInt(url.searchParams.get('limit') || '200', 10);

    if (qAts)    filtered = filtered.filter(m => m.job?.atsSource === qAts);
    if (qSearch) filtered = filtered.filter(m => {
      const q = qSearch;
      return (m.job?.title       || '').toLowerCase().includes(q) ||
             (m.job?.company     || '').toLowerCase().includes(q) ||
             (m.job?.description || '').toLowerCase().includes(q) ||
             (m.job?.atsSource   || '').toLowerCase().includes(q);
    });

    filtered = filtered.slice(0, Math.min(qLimit, 500));

    return json({
      ok:    true,
      count: filtered.length,
      total: items.length,
      jobs:  filtered,
    });
  }

  // POST /backfill-browse — RECOVERY ONLY (Rule 11).
  // Originally created because Browse capture was after the dedup gate (bug).
  // That bug is fixed in platform-do.js + batch.js (2026-06-06, f56188c).
  // Browse now auto-populates on every alarm cycle. This endpoint is retained
  // as a recovery tool if the store is manually cleared or needs priming.
  // Do NOT build automation on top of this — the alarm loop is the primary path.
  // Safe to run multiple times — saveUnmatchedJobs dedupes by job.id.
  if (url.pathname === '/backfill-browse' && request.method === 'POST') {
    const companies = await loadCompanyList(env) ?? SEED_COMPANIES;
    const unmatchedJobs = [];
    let polled = 0;
    let errors = 0;

    // Load global seen set so we know what's already matched
    // NOTE: migrated from STAT_KV to StateStoreDO (store.js migration 2026-06-06)
    let globalSeen;
    try {
      const raw = await storeGet(getStatStore(env), 'seen_ids');
      globalSeen = raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) { console.warn('[STAT backfill] globalSeen load failed (dedup may be incomplete):', e.message); globalSeen = new Set(); }

    for (const company of companies) {
      try {
        const jobs = await fetchCompanyJobs(company);
        polled++;
        for (const job of jobs) {
          // Ghost filter — canonical order per Rule 8 (must match alarm loop)
          if (job.daysAgo !== null && job.daysAgo > GHOST.suppress_after_days) continue;
          if (job.ghostFlag === 'suppress') continue;
          if (!passesEnvFilter(job)) continue;
          const match = matchJob(job);
          if (!match) {
            // Only add if NOT already a matched job (don't mix stores)
            if (!globalSeen.has(job.id)) {
              unmatchedJobs.push(job);
            }
          }
        }
        // Polite delay
        await new Promise(r => setTimeout(r, 150));
      } catch(e) {
        errors++;
      }
    }

    if (unmatchedJobs.length > 0) {
      await saveUnmatchedJobs(getStatStore(env), unmatchedJobs);
    }

    return json({
      ok: true,
      companies_polled: polled,
      unmatched_found: unmatchedJobs.length,
      errors,
      message: 'Browse store populated. Reload /browse to see results.',
    });
  }

  // GET /profile
  if (url.pathname === '/profile' && request.method === 'GET') {
    const profile = await loadProfile(env);
    if (!profile) return json({ stored: false });
    return json({ stored: true, profile });
  }

  // POST /score-job — score a job description against a stored profile via Gemini
  // Called by ui.html Resume tab "Score This Job". Keeps API keys server-side.
  if (url.pathname === '/score-job' && request.method === 'POST') {
    if (!env.GEMINI_KEY) return json({ error: 'GEMINI_KEY not configured' }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { profile, jd } = body;
    if (!profile || !jd) return json({ error: 'profile and jd required' }, 400);

    const systemPrompt = `You are a senior healthcare IT career advisor specializing in Epic EHR roles.
Score this candidate profile against the job description. Return ONLY valid JSON:
{
  "score": number 1-10,
  "verdict": "2-4 word verdict",
  "strengths": ["top 3 match points"],
  "gaps": ["top 2-3 gaps"],
  "salaryNote": "brief salary alignment note or null",
  "coverOpener": "2-sentence job-specific cover letter opener. Must reference the specific role and company."
}`;
    const userText = 'CANDIDATE PROFILE:\n' + JSON.stringify(profile, null, 2) + '\n\nJOB DESCRIPTION:\n' + jd.slice(0, 4000);

    try {
      const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + env.GEMINI_KEY;
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userText }] }],
          generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
        }),
      });
      const geminiData = await geminiRes.json();
      const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      const result = JSON.parse(cleaned);
      return json({ ok: true, result });
    } catch (e) {
      return json({ error: 'Scoring failed: ' + e.message }, 500);
    }
  }

  // POST /review — Claude-powered inline job review, streamed to the UI
  // Accepts { title, company, description, requisitionId } + optional stored profile
  // Returns a ReadableStream of SSE chunks: data: {token}\n\n
  // The UI renders these incrementally on the match card — no tab switch needed.
  if (url.pathname === '/review' && request.method === 'POST') {
    const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY || env.ANTHROPIC_KEY;
    if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 503);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { title, company, description, requisitionId, location, environment, salary } = body;
    if (!title) return json({ error: 'title required' }, 400);

    // Load stored profile for context (optional — review works without it)
    const profile = await loadProfile(env).catch(() => null);
    const profileCtx = profile
      ? `\n\nCANDIDATE PROFILE SUMMARY:\n${JSON.stringify(profile, null, 2).slice(0, 800)}`
      : '';

    // Include recent feedback history so Claude learns from past decisions
    const allMatches = await loadRecentMatches(getStatStore(env)).catch(() => []);
    const feedbackSignals = allMatches
      .filter(m => m.feedback)
      .slice(0, 20)
      .map(m => `${m.feedback.toUpperCase()}: ${m.job?.title || '?'} @ ${m.job?.company || '?'}${m.job?.environment ? ' (' + m.job.environment + ')' : ''}`)
      .join('\n');
    const feedbackCtx = feedbackSignals
      ? `\n\nRECENT DECISIONS (learn from these):\n${feedbackSignals}`
      : '';

    const jobText = [
      `Title: ${title}`,
      `Company: ${company || 'Unknown'}`,
      location ? `Location: ${location}` : null,
      environment ? `Environment: ${environment}` : null,
      salary ? `Salary: ${salary}` : null,
      description ? `\nDescription:\n${description.slice(0, 3000)}` : null,
    ].filter(Boolean).join('\n');

    const systemPrompt = `You are a sharp healthcare IT career advisor reviewing a job posting for an Epic EHR analyst.
Be direct and specific. No filler. Format your response with these exact sections:

**VERDICT** — One sentence: is this worth applying to and why?
**TOP SIGNALS** — 3 bullet points of the most relevant match points (or mismatches)
**DEALBREAKER** — One sentence if there is a clear dealbreaker, otherwise "None identified"
**QUICK TAKE** — One sentence advice on how to approach this application

Keep the entire response under 200 words. Use the candidate profile if provided.`;

    const userText = `REVIEW THIS JOB:\n${jobText}${profileCtx}${feedbackCtx}`;

    // Call Anthropic API with streaming
    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          stream: true,
          system: systemPrompt,
          messages: [{ role: 'user', content: userText }],
        }),
      });
    } catch (e) {
      return json({ error: 'Anthropic request failed: ' + e.message }, 502);
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      return json({ error: 'Anthropic error ' + anthropicRes.status + ': ' + errText.slice(0, 200) }, 502);
    }

    // Stream SSE tokens back to the browser
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        const reader = anthropicRes.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                const token = evt.delta.text;
                await writer.write(encoder.encode('data: ' + JSON.stringify({ token }) + '\n\n'));
              }
            } catch {}
          }
        }
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        await writer.write(encoder.encode('data: ' + JSON.stringify({ error: e.message }) + '\n\n'));
      } finally {
        writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // POST /extract-profile — extract structured profile from raw resume text via Gemini
  // Called by ui.html Resume tab. Keeps API keys server-side.
  if (url.pathname === '/extract-profile' && request.method === 'POST') {
    if (!env.GEMINI_KEY) return json({ error: 'GEMINI_KEY not configured' }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const resumeText = (body.text || '').slice(0, 8000);
    if (!resumeText) return json({ error: 'No text provided' }, 400);

    const systemPrompt = `You are a healthcare IT hiring specialist with deep knowledge of Epic EHR implementations.
Extract the candidate profile as JSON with EXACTLY these fields (use empty arrays/null if not present):
{
  "headline": "2-3 word professional summary",
  "yearsExperience": number or null,
  "epicModules": ["array of Epic module names"],
  "otherSystems": ["other EHR/HIT systems"],
  "certifications": ["Epic and other certs"],
  "skills": ["top 6 technical skills"],
  "targetRoles": ["appropriate job titles"],
  "environments": ["remote","hybrid","onsite"],
  "matchStrengths": ["3 strongest selling points"],
  "potentialGaps": ["2-3 genuine gaps — be domain-aware: Epic analyst/coordinator/specialist roles ARE hospital IT roles by definition; supporting a health system IS direct hospital IT experience; do not flag these as gaps. Only flag real gaps like: missing Epic certification for a role that requires it, no experience with a specific module the role needs, or genuinely missing skills the target roles demand."]
}
Return ONLY the JSON object, no markdown, no explanation.`;

    try {
      const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + env.GEMINI_KEY;
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: resumeText }] }],
          generationConfig: { maxOutputTokens: 800, temperature: 0.1 },
        }),
      });
      const geminiData = await geminiRes.json();
      const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      const profile = JSON.parse(cleaned);
      return json({ ok: true, profile });
    } catch (e) {
      return json({ error: 'Extraction failed: ' + e.message }, 500);
    }
  }

  // POST /profile — store resume profile for fit scoring
  if (url.pathname === '/profile' && request.method === 'POST') {
    let profile;
    try { profile = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    await saveProfile(env, profile);
    // Auto-generate personalized keywords from the new profile (non-blocking)
    generateAndStoreKeywords(profile, env).catch(e =>
      console.warn('[STAT] keyword gen failed:', e.message)
    );
    return json({
      ok: true, name: profile.name || '(unnamed)',
      fitScoring: env.GEMINI_KEY
        ? 'active — all future alerts will be scored against this profile'
        : 'profile stored but ANTHROPIC_API_KEY not set — run: wrangler secret put ANTHROPIC_API_KEY',
    });
  }

  // DELETE /profile
  if (url.pathname === '/profile' && request.method === 'DELETE') {
    await storeDel(getStatStore(env), 'resume_profile');
    return json({ ok: true, message: 'Profile removed. Fit scoring disabled.' });
  }

  // GET /learning — auto-discovered companies + promotion status
  if (url.pathname === '/learning' && request.method === 'GET') {
    const counts   = await loadMatchCounts(env);
    const registry = await loadDoRegistry(env);
    const entries  = Object.entries(counts)
      .map(([key, v]) => ({
        key, name: v.name, matchCount: v.count,
        promoted: !!registry[key]?.promoted,
        watching: !!registry[key],
        lastSeen: v.lastSeen ? new Date(v.lastSeen).toISOString() : null,
      }))
      .sort((a, b) => b.matchCount - a.matchCount);
    return json({
      total: entries.length,
      promoted: entries.filter(e => e.promoted).length,
      companies: entries,
    });
  }

  // POST /reset-seen — clear global seen IDs
  if (url.pathname === '/reset-seen' && request.method === 'POST') {
    const stub = getStatStore(env);
    // Count before clearing so UI can verify
    let cleared = 0;
    try {
      const raw = await storeGet(stub, 'seen_ids');
      cleared = raw ? JSON.parse(raw).length : 0;
    } catch {}
    await storeSet(stub, 'seen_ids', JSON.stringify([]));
    return json({ ok: true, cleared, message: `Cleared ${cleared} seen IDs — next poll re-evaluates all live Epic roles` });
  }

  // POST /reset-all — nuclear reset
  if (url.pathname === '/reset-all' && request.method === 'POST') {
    await storeSet(getStatStore(env), 'seen_ids', JSON.stringify([]));
    await storeSet(getStatStore(env), 'do_registry', JSON.stringify({}));
    await storeSet(getStatStore(env), 'match_counts', JSON.stringify({}));
    await storeDel(getStatStore(env), 'company_list');
    return json({ ok: true, message: 'Full reset — POST /bootstrap to re-initialize all platform DOs' });
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


  // ── GET /plain-fetch-test?url={url} ───────────────────────────────────────
  // Plain Worker fetch() diagnostic — no headless browser.
  // Tests whether Cloudflare Worker IPs are blocked by a given URL.
  // Returns HTTP status, response size, og:description, page title,
  // any job IDs found in href patterns, and a body text excerpt.
  //
  // Critical use: verifying iCIMS in_iframe=1 endpoints are reachable
  // from inside a Worker (Cloudflare IP) without Browser Rendering.
  //
  // Usage:
  //   /plain-fetch-test?url=https://careers-vhchealth.icims.com/jobs/search%3Fss%3D1%26in_iframe%3D1
  //
  if (url.pathname === '/plain-fetch-test' && request.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return json({ error: 'url param required' }, 400);

    const t0 = Date.now();
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control':   'no-cache',
        },
        redirect: 'follow',
      });

      const elapsed   = Date.now() - t0;
      const body      = await res.text();
      const bodyLen   = body.length;

      // Extract og:description
      const ogMatch = body.match(/<meta[^>]*(?:property|name)="og:description"[^>]*content="([^"]{10,})"[^>]*>/i)
                   || body.match(/<meta[^>]*content="([^"]{10,})"[^>]*(?:property|name)="og:description"[^>]*>/i);
      const ogDesc  = ogMatch?.[1] ?? '';

      // Page title
      const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title      = titleMatch?.[1]?.trim() ?? '';

      // Job IDs from href patterns — iCIMS: /jobs/{id}/
      const jobIdMatches = [...body.matchAll(/\/jobs\/(\d{4,6})\//g)];
      const jobIds = [...new Set(jobIdMatches.map(m => m[1]))].slice(0, 20);

      // Job hrefs
      const hrefMatches = [...body.matchAll(/href="(\/jobs\/\d+\/[^"?]+)"/g)];
      const jobHrefs = [...new Set(hrefMatches.map(m => m[1]))].slice(0, 10);

      // Body text excerpt (strip tags)
      const bodyText = body
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);

      // Blocked indicators
      const isBlocked = res.status === 403
        || title.includes('403')
        || title.includes('Forbidden')
        || title.includes('Access Denied');

      return json({
        ok:          !isBlocked && res.status < 400,
        url:         targetUrl,
        http_status: res.status,
        elapsed_ms:  elapsed,
        body_bytes:  bodyLen,
        is_blocked:  isBlocked,
        title,
        og_description:   ogDesc.slice(0, 300),
        job_ids:          jobIds,
        job_hrefs:        jobHrefs,
        body_text_excerpt: bodyText.slice(0, 300),
      });

    } catch (e) {
      return json({
        ok:        false,
        url:       targetUrl,
        elapsed_ms: Date.now() - t0,
        error:     e.message,
      }, 500);
    }
  }

  //
  // Usage:
  //   curl "https://stat-job-watcher.*.workers.dev/br-test?url=https://careers-vhchealth.icims.com/jobs/search&ats=icims"
  //
  if (url.pathname === '/br-test' && request.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    const ats       = url.searchParams.get('ats') ?? 'unknown';
    if (!targetUrl) return json({ error: 'url param required' }, 400);
    if (!env.MYBROWSER) return json({ error: 'MYBROWSER binding not available' }, 500);

    const t0 = Date.now();
    let browser = null;
    try {
      // Try session reuse first
      const sessions = await puppeteer.sessions(env.MYBROWSER);
      const idle = sessions.filter(s => !s.connectionId);
      if (idle.length > 0) {
        try { browser = await puppeteer.connect(env.MYBROWSER, idle[0].sessionId); } catch {}
      }
      if (!browser) browser = await puppeteer.launch(env.MYBROWSER);

      const page = await browser.newPage();

      // Suppress heavy resources to speed up SPA load
      await page.setRequestInterception(true);
      page.on('request', req => {
        const t = req.resourceType();
        if (['image', 'font', 'media', 'stylesheet'].includes(t)) req.abort();
        else req.continue();
      });

      await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 20_000 });

      // Extract everything useful from the rendered DOM
      const extracted = await page.evaluate(() => {
        // og:description or meta description
        const og = document.querySelector(
          'meta[property="og:description"], meta[name="og:description"], meta[name="description"]'
        );
        const ogDesc = og?.content ?? '';

        // Page title
        const title = document.title ?? '';

        // All job-like links (iCIMS: /jobs/{id}/..., Taleo: jobdetail.ftl?job=...)
        const allLinks = [...document.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(h => h && (
            h.includes('/jobs/') ||
            h.includes('jobdetail') ||
            h.includes('jobId=') ||
            h.includes('job=') ||
            h.includes('requisition')
          ))
          .slice(0, 20);

        // Visible text from likely job containers
        const jobText = [...document.querySelectorAll(
          '[class*="job"], [class*="position"], [class*="listing"], ' +
          '[id*="job"], [id*="search-results"], main, article'
        )]
          .map(el => el.innerText?.trim())
          .filter(t => t && t.length > 30)
          .slice(0, 3)
          .join('\n---\n');

        // DOM text excerpt from body (first 1000 chars of visible text)
        const bodyText = document.body?.innerText?.trim().slice(0, 1000) ?? '';

        // Count of elements that look like job cards
        const cardCount = document.querySelectorAll(
          '[class*="job-card"], [class*="job_card"], [class*="jobCard"], ' +
          '[class*="result-item"], [class*="posting"]'
        ).length;

        return { ogDesc, title, allLinks, jobText, bodyText, cardCount };
      });

      await page.close();
      await browser.disconnect();

      const elapsed = Date.now() - t0;
      return json({
        ok:       true,
        ats,
        url:      targetUrl,
        elapsed_ms: elapsed,
        title:    extracted.title,
        og_description: extracted.ogDesc,
        job_links: extracted.allLinks,
        job_card_count: extracted.cardCount,
        dom_text_excerpt: extracted.bodyText.slice(0, 500),
        job_container_text: extracted.jobText.slice(0, 500),
      });

    } catch (e) {
      if (browser) { try { await browser.close(); } catch {} }
      return json({ ok: false, ats, url: targetUrl, error: e.message, elapsed_ms: Date.now() - t0 }, 500);
    }
  }

  // ── POST /hc-probe — fetch any HC URL from CF IP, return __NEXT_DATA__ ─────
  // Used for one-off probes of HC listing/search pages.
  // HC blocks GitHub runner IPs; CF Worker IPs are not blocked.
  // Body: { url: string }
  // Returns: { ok, url, nextData, ssrKeys, ssrHitsCount, ssrTotalCount,
  //            ssrPageSize, ssrIsLastPage, hitsHaveV5, algoliaSignals,
  //            httpStatus, bytes }
  if (url.pathname === '/hc-probe' && request.method === 'POST') {
    let targetUrl;
    try {
      const body = await request.json();
      targetUrl = body.url;
      if (!targetUrl || !targetUrl.includes('hiring.cafe')) {
        return json({ ok: false, error: 'url must be a hiring.cafe URL' }, 400);
      }
    } catch (e) {
      return json({ ok: false, error: 'invalid JSON body' }, 400);
    }

    try {
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const httpStatus = res.status;
      const html = await res.text();
      const bytes = html.length;

      // Extract __NEXT_DATA__
      const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!ndMatch) {
        return json({ ok: false, url: targetUrl, httpStatus, bytes, error: 'no __NEXT_DATA__ found' });
      }

      const nextData = JSON.parse(ndMatch[1]);
      const pp = nextData?.props?.pageProps ?? {};
      const ssrKeys = Object.keys(pp);

      // Listing page signals
      const ssrHits = pp.ssrHits ?? [];
      const ssrHitsCount = ssrHits.length;
      const ssrTotalCount = pp.ssrTotalCount ?? null;
      const ssrPageSize = pp.ssrPageSize ?? null;
      const ssrIsLastPage = pp.ssrIsLastPage ?? null;
      const ssrPage = pp.ssrPage ?? null;
      const ssrError = pp.ssrError ?? null;
      const initialSearchState = pp.initialSearchState ?? null;
      const ssrTimings = nextData?.ssrTimings ?? null;

      // Check if ssrHits contain v5_processed_job_data
      const hitsHaveV5 = ssrHits.length > 0 && 'v5_processed_job_data' in ssrHits[0];
      const hitsHaveEnriched = ssrHits.length > 0 && 'enriched_company_data' in ssrHits[0];
      const hitsHaveDesc = ssrHits.length > 0 && !!(ssrHits[0]?.job_information?.description);

      // Algolia signals: objectID field, _geoloc field
      const algoliaSignals = {
        hasObjectId: ssrHits.length > 0 && 'objectID' in ssrHits[0],
        hasGeoloc: ssrHits.length > 0 && '_geoloc' in ssrHits[0],
        pageObjectId: 'objectID' in (pp.job ?? {}),
      };

      // Sample first hit (stripped for size)
      let firstHitSample = null;
      if (ssrHits.length > 0) {
        const h = ssrHits[0];
        firstHitSample = {
          id: h.id,
          objectID: h.objectID,
          source: h.source,
          board_token: h.board_token,
          requisition_id: h.requisition_id,
          collapse_key: h.collapse_key,
          is_expired: h.is_expired,
          title: h.job_information?.title,
          v5_keys: h.v5_processed_job_data ? Object.keys(h.v5_processed_job_data) : null,
          enriched_keys: h.enriched_company_data ? Object.keys(h.enriched_company_data) : null,
          hc_geoloc: h._geoloc,
        };
      }

      // Check for Algolia credentials in page HTML
      const algoliaCredsInHtml = {
        algoliaNet: /[a-zA-Z0-9]{10}\.algolia\.net/.test(html),
        algoliaAppId: /X-Algolia-Application-Id/.test(html),
        algoliaApiKey: /X-Algolia-API-Key/.test(html),
        algoliaInstantSearch: /instantsearch|algoliasearch/i.test(html),
        appIdPattern: (html.match(/[A-Z0-9]{10}(?=\.algolia)/g) ?? []),
      };

      // Pagination signals from URL params or HTML
      const paginationSignals = {
        pageParam: /[?&]page=\d+/.test(targetUrl),
        offsetParam: /[?&]offset=\d+/.test(targetUrl),
        ssrPage,
        ssrIsLastPage,
        nextPageHint: pp.nextPage ?? pp.nextCursor ?? null,
      };

      // searchState from URL
      let parsedSearchState = null;
      try {
        const searchStateParam = new URL(targetUrl).searchParams.get('searchState');
        if (searchStateParam) parsedSearchState = JSON.parse(decodeURIComponent(searchStateParam));
      } catch {}

      return json({
        ok: true,
        url: targetUrl,
        httpStatus,
        bytes,
        buildId: nextData.buildId,
        page: nextData.page,
        query: nextData.query,
        gsp: nextData.gsp,
        ssrKeys,
        ssrHitsCount,
        ssrTotalCount,
        ssrPageSize,
        ssrIsLastPage,
        ssrPage,
        ssrError,
        ssrTimings,
        hitsHaveV5,
        hitsHaveEnriched,
        hitsHaveDesc,
        algoliaSignals,
        algoliaCredsInHtml,
        paginationSignals,
        parsedSearchState,
        initialSearchState,
        firstHitSample,
      });
    } catch (e) {
      return json({ ok: false, url: targetUrl, error: e.message }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ATS URL DETECTOR  (jobhive-manifest probe: v2026-06-07)
// Parses a career page URL and returns { ats, token, url } or null.
// Supports: Greenhouse, Lever, Ashby, Workday, iCIMS, Taleo, SuccessFactors.
// Custom domains (e.g. careers.medstarhealth.org) return null — can't detect
// without a network fetch, which the UI can handle via a fallback message.
// ─────────────────────────────────────────────────────────────────────────────
function detectAts(rawUrl) {
  try {
    const u   = new URL(rawUrl.trim());
    const host = u.hostname;
    const path = u.pathname;

    // Greenhouse: boards.greenhouse.io/{token}
    if (host === 'boards.greenhouse.io') {
      const token = path.replace(/^\//, '').split('/')[0];
      return token ? { ats: 'greenhouse', token, url: null } : null;
    }

    // Lever: jobs.lever.co/{token}
    if (host === 'jobs.lever.co') {
      const token = path.replace(/^\//, '').split('/')[0];
      return token ? { ats: 'lever', token, url: null } : null;
    }

    // Ashby: jobs.ashbyhq.com/{token}
    if (host === 'jobs.ashbyhq.com') {
      const token = path.replace(/^\//, '').split('/')[0];
      return token ? { ats: 'ashby', token, url: null } : null;
    }

    // Workday: {tenant}.wd{N}.myworkdayjobs.com
    const wdMatch = host.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/);
    if (wdMatch) {
      return { ats: 'workday', token: wdMatch[1], url: rawUrl };
    }

    // iCIMS: {tenant}.icims.com
    if (host.endsWith('.icims.com')) {
      const tenant = host.split('.')[0];
      return { ats: 'icims', token: tenant,
               url: `https://\${host}/jobs/search` };
    }

    // Taleo: {tenant}.taleo.net
    if (host.endsWith('.taleo.net')) {
      const tenant = host.split('.')[0];
      const csMatch = path.match(/\/careersection\/([^\/]+)\//);
      const cs = csMatch ? csMatch[1] : '2';
      return { ats: 'taleo', token: tenant,
               url: `https://\${host}/careersection/\${cs}/jobsearch.ftl` };
    }

    // SuccessFactors: career4.successfactors.com?company={token}
    if (host.includes('successfactors.com')) {
      const company = u.searchParams.get('company');
      return company ? { ats: 'successfactors', token: company, url: rawUrl } : null;
    }

    return null;
  } catch { return null; }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
  async fetch(request, env, ctx) {
    return handleFetch(request, env);
  },
};
// browser rendering + SF fix deployed — ANTHROPIC_API_KEY active 2026-06-07
// re-deploy 20260607T015549Z
