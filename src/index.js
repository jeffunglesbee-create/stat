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
  IcimsDO, SuccessFactorsDO, TaleoDO, OracleHcmDO, InforHcmDO, SelectMindsDO,
} from './platform-do.js';

import { SEED_COMPANIES, BATCH_WATCHLIST, KV, HIRINGCAFE, BATCH_POLLER, LEARNING } from './config.js';
import { bootstrapSalaryDO, enrichJobWithSalary } from './salary.js';
import { applyMarylandScore } from './maryland.js';
import { enrichDescriptions } from './enrich.js';
import { fetchHiringCafe } from './adapters.js';
import { matchJob, passesEnvFilter, dispatchAlerts, checkJobLiveness } from './notify.js';
import { scoreBatch, companyAwarePriority } from './fit.js';
import puppeteer from '@cloudflare/puppeteer';
import { getStatStore, storeGet, storeSet, storeDel, saveRecentMatches, loadRecentMatches, loadUnmatchedJobs, saveUnmatchedJobs, appendLog, readLog, maybeAddOrPromoteCompany } from './store.js';
export { StateStoreDO } from './store.js';
import { json } from './routes/_utils.js';
import { handleUI } from './routes/ui.js';
import { handleSalary } from './routes/salary.js';
import { handleOperations } from './routes/operations.js';
import { handleCompanies } from './routes/companies.js';
import { handleJobs } from './routes/jobs.js';
import { handleProfile } from './routes/profile.js';
import { handleDiagnostics } from './routes/diagnostics.js';
import {
  SEEN_SWEEP_BATCH,
  loadSeenIds, saveSeenIds, markSeenDead, checkSeenStatus, addToSeen,
  loadCompanyList, saveCompanyList,
  loadDoRegistry, saveDoRegistry,
  loadProfile, saveProfile,
  loadMatchCounts, saveMatchCounts,
} from './state.js';

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STATE — DO SQLite helpers (via StateStoreDO)
// All five previously-KV keys now live in StateStoreDO SQLite storage.
// Helpers accept env and derive the stub internally for a clean call site.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// SEEN-IDS — structured format with TTL + ghost resurrection
//
// Entry format: { id, seenAt, diedAt?, url? }
//   id:      job ID string
//   seenAt:  ISO timestamp of first alert
//   diedAt:  ISO timestamp of confirmed liveness failure (4xx). Cleared on resurrection.
//   url:     apply URL for liveness re-check. Sourced from match history first.
//
// TTL: entries with diedAt set AND diedAt > SEEN_TTL_MS ago are pruned.
//      Live entries never expire (a job re-posting gets a new ID on most ATS).
//      Exception: entries older than SEEN_LIVE_MAX_MS are pruned regardless,
//      as a safety net against seen-set growth from platforms with stable IDs.
//
// Ghost resurrection: if diedAt is set AND liveness check returns 'live',
//      the entry is treated as new — diedAt cleared, alert fires again.
//
// Storage: global seen-set in StateStoreDO 'seen_ids' (JSON array of entry objects).
//          Per-platform seen-set in DO storage also updated (see platform-do.js).
//
// Backward compat: raw strings in stored array are treated as { id, seenAt: epoch0 }.
// ─────────────────────────────────────────────────────────────────────────────

// State helpers (loadSeenIds, saveSeenIds, markSeenDead, etc.) live in
// src/state.js so the route files can import them without circularity.
// Constants and helpers are imported below alongside other dependencies.

// ── Cron sweep: re-check a batch of dead seen entries for ghost resurrection ──
// 20 entries per cron tick. HEAD request on each. If live → clear diedAt (resurrect).
// Resurrection path: job re-enters the match pipeline on next DO alarm cycle
// (it's no longer in the dead-marked set, so it won't be deduped).
async function maybeRunSeenSweep(env) {
  try {
    const seenMap = await loadSeenIds(env);
    // Collect dead entries that have a URL (can be re-checked)
    const deadWithUrl = Array.from(seenMap.values())
      .filter(e => e.diedAt && e.url)
      .sort((a, b) => new Date(a.diedAt).getTime() - new Date(b.diedAt).getTime()); // oldest first

    if (deadWithUrl.length === 0) return;

    // Use sweep cursor stored separately to avoid re-checking the same entries every tick
    const cursorRaw = await storeGet(getStatStore(env), 'seen_sweep_cursor');
    const cursor    = cursorRaw ? parseInt(cursorRaw, 10) : 0;
    const batch     = deadWithUrl.slice(cursor, cursor + SEEN_SWEEP_BATCH);

    if (batch.length === 0) {
      // Cursor past end — reset
      await storeSet(getStatStore(env), 'seen_sweep_cursor', '0');
      return;
    }

    let resurrected = 0;
    for (const entry of batch) {
      try {
        const res = await fetch(entry.url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok || res.status === 301 || res.status === 302) {
          // Job is live again — clear diedAt so next DO alarm cycle re-evaluates it
          delete entry.diedAt;
          resurrected++;
          console.log(`[STAT sweep] Resurrected: ${entry.id} (${entry.url})`);
        }
        // 4xx = still dead, leave as-is. 5xx/timeout = unknown, leave as-is.
      } catch { /* timeout or network error — leave as-is */ }
    }

    // Save updated map and advance cursor
    if (resurrected > 0) await saveSeenIds(env, seenMap);
    const nextCursor = cursor + SEEN_SWEEP_BATCH;
    await storeSet(getStatStore(env), 'seen_sweep_cursor',
      nextCursor >= deadWithUrl.length ? '0' : String(nextCursor));

    if (resurrected > 0) {
      console.log(`[STAT sweep] ${resurrected} resurrected from ${batch.length} checked`);
    }
  } catch (e) {
    console.warn('[STAT sweep] seen sweep failed:', e.message);
  }
}

// loadCompanyList/saveCompanyList/loadDoRegistry/saveDoRegistry/
// loadProfile/saveProfile/loadMatchCounts/saveMatchCounts live in src/state.js.

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE-DRIVEN KEYWORD GENERATION
// When a profile is stored, generate a personalized keyword list via Gemini
// and store it in StateStoreDO. matchJob() uses this list + the static list.
// Gives STAT contextual understanding of what jobs fit this specific person.
// ─────────────────────────────────────────────────────────────────────────────

export async function generateAndStoreKeywords(profile, env) {
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
1. EXACT: multi-word phrases from Epic/EHR job titles (e.g. "epic ambulatory analyst", "ehr application analyst"). Every phrase must contain an Epic, EHR, or clinical qualifier.
2. BROAD: single words UNIQUE to healthcare IT (e.g. "ambulatory", "cogito", "clarity", "cadence", "willow", "radiant", "caboodle"). NEVER include generic words like "analyst", "engineer", "consultant", "data", "coordinator", "manager", "solutions", "strategy", or "optimization" — these match non-healthcare jobs.
3. ADJACENT: healthcare IT roles this person could pivot to (e.g. "clinical informatics analyst", "health informatics specialist"). Must reference healthcare/clinical domain.

Also include certification-opportunity signals in EXACT:
- "within epic", "epic certification", "epic training", "epic go-live", "epic build"

Return ONLY JSON, no markdown:
{"exact":["phrase1","phrase2"],"broad":["word1","word2"],"adjacent":["phrase1","phrase2"]}

Max 15 per category. All lowercase. Every term must be healthcare/Epic-specific.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(8000),
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
    console.warn('[STAT keywords] Generation failed:', e.message, e.stack?.slice(0, 200));
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ONEDRIVE RESUME AUTO-FETCH
// Fetches resume from a OneDrive public share link, extracts text,
// and stores the profile — no user interaction required.
// Requires: ONEDRIVE_RESUME_URL secret (share link with "Anyone can view")
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchResumeFromOneDrive(env) {
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
      signal: AbortSignal.timeout(8000),
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
export async function bootstrapDOs(env) {
  // Merge stored company watchlist with current SEED_COMPANIES.
  // Ensures newly added seed entries (e.g. UTMB SelectMinds) are picked up
  // without wiping manually-added companies from POST /companies.
  // Merge: seed entries keyed by (ats+token); new seeds appended, manual entries preserved.
  const stored = await loadCompanyList(env) ?? [];
  // Key by (ats, url) — url is stable. token changes for cursor-walking adapters (SelectMinds).
  // Keying by token would cause duplicate entries when token is updated in config.
  const storedKeys = new Set(stored.map(c => `${c.ats}:${c.url ?? c.token}`));
  const newFromSeed = SEED_COMPANIES.filter(c => !storedKeys.has(`${c.ats}:${c.url ?? c.token}`));
  if (newFromSeed.length > 0 || stored.length === 0) {
    const merged = stored.length > 0 ? [...stored, ...newFromSeed] : SEED_COMPANIES;
    await saveCompanyList(env, merged);
  }
  const companies = stored.length > 0
    ? (newFromSeed.length > 0 ? [...stored, ...newFromSeed] : stored)
    : SEED_COMPANIES;

  // Platform DO map: binding name → ATS key
  const PLATFORM_DOS = [
    { binding: 'GREENHOUSE_DO',     ats: 'greenhouse' },
    { binding: 'LEVER_DO',          ats: 'lever' },
    { binding: 'ASHBY_DO',          ats: 'ashby' },
    { binding: 'WORKDAY_DO',        ats: 'workday' },
    { binding: 'ICIMS_DO',          ats: 'icims' },
    { binding: 'SUCCESSFACTORS_DO', ats: 'successfactors' },
    { binding: 'TALEO_DO',          ats: 'taleo' },
    { binding: 'ORACLE_HCM_DO',     ats: 'oracle_hcm' },
    { binding: 'INFOR_HCM_DO',      ats: 'infor_hcm' },
    { binding: 'SELECTMINDS_DO',    ats: 'selectminds' },
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
// Pre-filtered Epic-relevant HC terms — hoisted from inside the env loop so we
// don't recompute the same subset on every cron tick.
const HC_EPIC_TERMS = HIRINGCAFE.search_terms.filter(t =>
  t.startsWith('epic') || t.includes('ehr') || t.includes('clarity') ||
  t.includes('informatics') || t.includes('him analyst')
);

export async function runHiringCafeScrape(env) {
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
    // Rotate through Epic search terms — one per cron cycle via timestamp
    // searchState.searchQuery is processed against title + description + v5 fields
    const termIdx = Math.floor(Date.now() / (60_000)) % HC_EPIC_TERMS.length;
    const activeTerm = HC_EPIC_TERMS[termIdx] ?? 'epic analyst';
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
      const seenStatus = seenThisRun.has(job.id) ? 'seen' : checkSeenStatus(seenIds, job.id);
      if (seenStatus === 'seen') {
        seenThisRun.add(job.id);
        continue;
      }
      if (seenStatus === 'dead') {
        // Ghost resurrection check: re-run liveness — if live, treat as new
        const liveness = await checkJobLiveness(job);
        if (liveness !== 'live') { seenThisRun.add(job.id); continue; }
        // Job resurrected — clear diedAt in map so it re-enters the pipeline
        const entry = seenIds.get(job.id);
        if (entry) delete entry.diedAt;
        console.log(`[STAT HC] Ghost resurrected: ${job.id} ${job.title}`);
        // Fall through to full match pipeline below
      }
      seenThisRun.add(job.id);
      addToSeen(seenIds, job.id, job.url);

      if (job.ghostFlag === 'suppress') continue;
      // Browse capture — all env-filtered jobs, including matched ones (Rule 8)
      if (passesEnvFilter(job)) {
        unmatchedJobsHC.push(job);
      }
      if (!passesEnvFilter(job)) continue;
      const match = matchJob(job, hcCustomKeywords);
      if (!match) continue;

      job.matchedKeyword = match.matchedKw;

      // ── Liveness check ────────────────────────────────────────────────────
      // HEAD request to job.url (ATS apply_url) — confirms posting still live.
      // 4xx → dead (mark in seen-set, skip). timeout/5xx → unknown (let through).
      const liveness = await checkJobLiveness(job);
      if (liveness === 'dead') {
        markSeenDead(env, job.id, job.url).catch(() => {});
        continue;
      }
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
    // Strip description before StateStoreDO write — descriptions live in R2.
    // UI fetches via GET /description/:jobId on card expand.
    const matchesForStore = newMatches.map(m => ({
      ...m, job: { ...m.job, description: undefined },
    }));
    await saveRecentMatches(getStatStore(env), matchesForStore);
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

  // Wide-net HiringCafe scrape — must complete before jobhive (both write seen_ids)
  await runHiringCafeScrape(env);

  // Salary refresh + seen sweep are independent of each other and of jobhive.
  // Run in parallel after HC scrape completes:
  //   maybeRefreshSalaryCaches — touches SalaryDO only, never seen_ids
  //   maybeRunSeenSweep        — reads/writes seen_ids (dead entries only, no promo writes)
  // Both complete before jobhive starts, so no seen_ids write contention.
  await Promise.all([
    maybeRefreshSalaryCaches(env),
    maybeRunSeenSweep(env),
  ]);

  // jobhive CSV scan — runs once per hour, not every minute.
  // Streams jobhive's ATS slices to find Epic roles at companies outside the seed list.
  // Discovered companies auto-promoted via maybeAddOrPromoteCompany() (healthcare gate).
  // Runs last — also writes seen_ids, must not overlap with HC scrape or sweep.
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

export function matchesEpicTerms(text, returnTerm = false) {
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
export function splitCSVRows(chunk, carry, carryInQuote) {
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

export function parseCSVRow(line) {
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

export function cleanDesc(raw) {
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
            const jobSeenStatus = checkSeenStatus(seenIds, jobId);
            if (jobSeenStatus === null || jobSeenStatus === 'dead') {
              // dead → ghost resurrection opportunity; null → new job
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

                addToSeen(seenIds, jobId, applyUrl);
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
          }, { gate: 'strict' }).catch(e =>
            console.warn('[STAT jobhive] promote failed:', e.message));
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

  {
    const r = await handleUI(request, url, env);
    if (r) return r;
  }

  {
    const r = await handleOperations(request, url, env);
    if (r) return r;
  }

  {
    const r = await handleSalary(request, url, env);
    if (r) return r;
  }

  {
    const r = await handleCompanies(request, url, env);
    if (r) return r;
  }

  {
    const r = await handleJobs(request, url, env);
    if (r) return r;
  }

  {
    const r = await handleProfile(request, url, env);
    if (r) return r;
  }

  {
    const r = await handleDiagnostics(request, url, env);
    if (r) return r;
  }

  return json({ error: 'Not found' }, 404);
}

// json() helper now lives in src/routes/_utils.js — imported below.

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
export function detectAts(rawUrl) {
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
// deploy trigger 2026-06-16T17:58:51Z
