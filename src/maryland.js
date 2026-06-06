/**
 * STAT — Maryland Remote Work Eligibility Scorer
 *
 * Scores each matched job for likelihood that a Maryland-based remote worker
 * is eligible. No ATS exposes "approved states" as a structured field — this
 * is a best-effort signal from three sources ranked by reliability:
 *
 * Source 1 (most reliable): Company seed tag
 *   Companies in SEED_COMPANIES or BATCH_WATCHLIST with mdApproved:true
 *   are known Maryland-registered employers. These are curated facts.
 *
 * Source 2 (reliable for DC-area employers): Location string
 *   Job location contains Maryland/Baltimore/DMV signals → positive
 *   Job location contains states far from MD without "nationwide" → weak negative
 *
 * Source 3 (variable coverage): Job description text
 *   Only available from Greenhouse (?content=true), Lever, Ashby.
 *   Workday/iCIMS/Taleo/SuccessFactors rarely return description body.
 *   Explicit MD inclusion → strong positive
 *   Explicit MD exclusion → hard suppress
 *   "All 50 states" / "nationwide" / "anywhere in US" → neutral-positive
 *
 * Score interpretation:
 *   ≥ 4  : Maryland likely — boost priority, add 📍 MD badge
 *   1–3  : Maryland possible — no change, badge in email only
 *   0    : Unknown — no change, no badge
 *  -1 or below : Maryland excluded — suppress entirely
 *
 * This is designed to be fast (no API calls, pure text analysis) and
 * non-blocking (failure returns score 0, job proceeds normally).
 */

// ── Maryland positive signals ─────────────────────────────────────────────────
const MD_POSITIVE = [
  /\bmaryland\b/i,
  /\bmd\b/,              // short abbrev — careful, could be "md" in other contexts
  /\bbaltimore\b/i,
  /\bannapolis\b/i,
  /\bbethesda\b/i,
  /\bsilver spring\b/i,
  /\brockville\b/i,
  /\bgaithersburg\b/i,
  /\bchevy chase\b/i,
  /\bgreenbelt\b/i,
  /\bcolumbia.*md\b/i,
  /\bdmv\b/i,            // DC-Maryland-Virginia region
  /\bdc.{0,10}metro\b/i,
  /\bmid.?atlantic\b/i,
  /\bnortheast\b/i,      // weak but positive for MD-area employers
];

// Strong positive — "all states", "nationwide", "anywhere in US"
const MD_NATIONWIDE = [
  /\ball\s+50\s+states\b/i,
  /\bnationwide\b/i,
  /\banywhere\s+in\s+the\s+u\.?s\.?\b/i,
  /\bany\s+state\b/i,
  /\bacross\s+the\s+(u\.?s\.?|united\s+states)\b/i,
  /\bfully\s+remote\b.*\busa\b/i,
];

// Explicit Maryland approval in description
const MD_EXPLICIT_INCLUDE = [
  /\bmaryland\b.*\beligible\b/i,
  /\beligible\b.*\bmaryland\b/i,
  /\bmaryland\b.*\bapproved\b/i,
  /\bapproved\b.*\bmaryland\b/i,
  /\bmaryland\b.*\bauthorized\b/i,
  /\bopen\s+to\s+.*maryland\b/i,
  /\bmd\b.*\beligible\b/i,
  /\bavailable\s+in\s+.*\bmd\b/i,
  /\bavailable\s+in\s+.*\bmaryland\b/i,
];

// Explicit exclusions
const MD_EXCLUDE = [
  /\bnot\s+(available|eligible|open)\s+(in|to)\s+.*\bmaryland\b/i,
  /\bexcluding?\s+.*\bmaryland\b/i,
  /\bmaryland\b.*\bnot\s+(available|eligible|open)\b/i,
  /\bcannot\s+(hire|work)\s+(in|from)\s+.*\bmaryland\b/i,
  /\bmd\b.*\bnot\s+(available|eligible)\b/i,
  // State restriction lists that don't include MD
  // e.g. "available in CA, TX, NY, FL" — if we see a state list without MD
  // we check separately in scoreDescription
];

// ── Score calculator ──────────────────────────────────────────────────────────

/**
 * Score a job for Maryland remote work eligibility.
 * Returns { score, signals, badge }
 *
 * score:   number (see thresholds above)
 * signals: array of strings explaining what was found
 * badge:   null | '📍 MD likely' | '📍 MD possible' | '🚫 MD excluded'
 */
export function scoreMarylandEligibility(job, companyMeta = null) {
  let score = 0;
  const signals = [];

  // ── Source 1: Company seed tag ─────────────────────────────────────────────
  if (companyMeta?.mdApproved === true) {
    score += 4;
    signals.push('company tagged MD-approved');
  } else if (companyMeta?.mdApproved === false) {
    score -= 5;
    signals.push('company tagged MD-excluded');
    return { score, signals, badge: '🚫 MD excluded' };
  }

  // ── Source 2: Location string ──────────────────────────────────────────────
  const loc = (job.location ?? '').toLowerCase();

  if (loc) {
    // Strong positive: location explicitly in MD/DMV
    const mdLoc = MD_POSITIVE.slice(0, 10); // geographic signals only
    if (mdLoc.some(r => r.test(loc))) {
      score += 3;
      signals.push(`location: "${job.location}"`);
    }

    // "Remote" with no state context — neutral, don't penalize
    // "Remote - CA" or "Remote (California only)" — weak negative if not MD
    if (/remote.*\b(ca|california|colorado|co|new york|ny|texas|tx|washington state|wa)\b/i.test(loc)
        && !/remote.*\b(md|maryland|dc|virginia|va)\b/i.test(loc)) {
      score -= 1;
      signals.push('location suggests non-MD state');
    }
  }

  // ── Source 3: Description text ─────────────────────────────────────────────
  const desc = (job.description ?? '').toLowerCase();

  if (desc) {
    // Hard exclude
    if (MD_EXCLUDE.some(r => r.test(desc))) {
      score -= 10;
      signals.push('description explicitly excludes MD');
      return { score, signals, badge: '🚫 MD excluded' };
    }

    // Explicit state restriction list — check if it includes MD
    // Pattern: "available in AK, AL, AR..." style lists
    const stateListMatch = desc.match(
      /(?:available|eligible|open|hiring)\s+in\s+((?:[a-z]{2}(?:,\s*)?){3,})/i
    );
    if (stateListMatch) {
      const stateList = stateListMatch[1].toUpperCase();
      const hasMD = /\bMD\b/.test(stateList);
      if (hasMD) {
        score += 3;
        signals.push('state list includes MD');
      } else if (stateList.length > 10) {
        // Long list that doesn't include MD
        score -= 2;
        signals.push('state list does not include MD');
      }
    }

    // Nationwide / all states
    if (MD_NATIONWIDE.some(r => r.test(desc))) {
      score += 2;
      signals.push('nationwide remote');
    }

    // Explicit MD inclusion
    if (MD_EXPLICIT_INCLUDE.some(r => r.test(desc))) {
      score += 3;
      signals.push('description explicitly includes MD');
    }

    // Maryland mentioned positively anywhere
    if (/\bmaryland\b/i.test(desc) && !MD_EXCLUDE.some(r => r.test(desc))) {
      score += 1;
      signals.push('Maryland mentioned in description');
    }
  }

  // ── Badge assignment ───────────────────────────────────────────────────────
  let badge = null;
  if (score >= 4)       badge = '📍 MD likely';
  else if (score >= 1)  badge = '📍 MD possible';
  else if (score < 0)   badge = '🚫 MD excluded';

  return { score, signals, badge };
}

/**
 * Apply Maryland scoring to a job in-place.
 * Sets job.mdScore, job.mdBadge, job.mdSignals.
 * Returns true if job should be suppressed (MD explicitly excluded).
 */
export function applyMarylandScore(job, companyMeta = null) {
  try {
    const { score, signals, badge } = scoreMarylandEligibility(job, companyMeta);
    job.mdScore   = score;
    job.mdBadge   = badge;
    job.mdSignals = signals;
    // Suppress only on explicit exclusion (score very negative)
    return score <= -5;
  } catch {
    job.mdScore = 0;
    job.mdBadge = null;
    return false;
  }
}
