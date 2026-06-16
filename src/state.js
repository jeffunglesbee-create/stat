// ─────────────────────────────────────────────────────────────────────────────
// State helpers — JSON wrappers over StateStoreDO SQLite keys.
//
// Routes and the cron handler share these to read/write:
//   - seen_ids (Map<jobId, entry>) with TTL pruning + dead/live distinction
//   - company_list (auto-discovered companies merged with SEED)
//   - do_registry (which platform DOs are bootstrapped)
//   - resume_profile (Gemini-extracted candidate data)
//   - match_counts (per-company promotion gate)
//
// All helpers return safe defaults on parse failure — callers may assume
// the wrappers never throw.
// ─────────────────────────────────────────────────────────────────────────────

import { getStatStore, storeGet, storeSet } from './store.js';
import { KV } from './config.js';

export const SEEN_TTL_MS      = 30 * 24 * 60 * 60 * 1000; // 30 days — prune dead entries
export const SEEN_LIVE_MAX_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — hard cap on all entries
export const SEEN_SWEEP_BATCH = 20;                         // entries checked per cron tick

function _parseSeenEntry(raw) {
  if (typeof raw === 'string') return { id: raw, seenAt: new Date(0).toISOString() };
  return raw;
}

export async function loadSeenIds(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'seen_ids');
    if (!raw) return new Map();
    const arr = JSON.parse(raw);
    const map = new Map();
    for (const item of arr) {
      const entry = _parseSeenEntry(item);
      map.set(entry.id, entry);
    }
    return map;
  } catch { return new Map(); }
}

export async function saveSeenIds(env, seenMap) {
  let arr = Array.from(seenMap.values());
  // Prune: dead entries older than TTL, live entries older than hard cap
  const now = Date.now();
  arr = arr.filter(e => {
    if (e.diedAt && (now - new Date(e.diedAt).getTime()) > SEEN_TTL_MS) return false;
    if (!e.diedAt && (now - new Date(e.seenAt).getTime()) > SEEN_LIVE_MAX_MS) return false;
    return true;
  });
  if (arr.length > KV.max_seen) arr = arr.slice(-KV.max_seen);
  await storeSet(getStatStore(env), 'seen_ids', JSON.stringify(arr));
}

// Mark a seen entry as dead (liveness check failed). URL stored for future re-check.
export async function markSeenDead(env, jobId, jobUrl) {
  try {
    const seenMap = await loadSeenIds(env);
    const entry = seenMap.get(jobId);
    if (!entry) return;
    entry.diedAt = new Date().toISOString();
    if (jobUrl && !entry.url) entry.url = jobUrl;
    await saveSeenIds(env, seenMap);
  } catch (e) {
    console.warn('[STAT seen] markSeenDead failed:', e.message);
  }
}

// Check if a job is seen: returns null (not seen), 'seen' (live), or 'dead' (diedAt set).
export function checkSeenStatus(seenMap, jobId) {
  const entry = seenMap.get(jobId);
  if (!entry) return null;
  if (entry.diedAt) return 'dead';
  return 'seen';
}

// Add a new job to the seen-set with optional URL.
export function addToSeen(seenMap, jobId, jobUrl) {
  seenMap.set(jobId, {
    id:     jobId,
    seenAt: new Date().toISOString(),
    ...(jobUrl ? { url: jobUrl } : {}),
  });
}

export async function loadCompanyList(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'company_list');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function saveCompanyList(env, list) {
  await storeSet(getStatStore(env), 'company_list', JSON.stringify(list));
}

export async function loadDoRegistry(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'do_registry');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export async function saveDoRegistry(env, registry) {
  await storeSet(getStatStore(env), 'do_registry', JSON.stringify(registry));
}

export async function loadProfile(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'resume_profile');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function saveProfile(env, p) {
  await storeSet(getStatStore(env), 'resume_profile', JSON.stringify(p));
}

export async function loadMatchCounts(env) {
  try {
    const raw = await storeGet(getStatStore(env), 'match_counts');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export async function saveMatchCounts(env, c) {
  await storeSet(getStatStore(env), 'match_counts', JSON.stringify(c));
}
