/**
 * STAT — Resume Fit Scoring
 *
 * Scores incoming job matches against a stored resume profile using the
 * Anthropic API. Integrates into the alert pipeline to filter by fit,
 * not just keyword match.
 *
 * Architecture:
 *   - Profile stored in StateStoreDO SQLite (key: resume_profile)
 *   - Extracted by resume-matcher.html and POSTed to /profile
 *   - Each new match scored before dispatch
 *   - Score gates Pushover priority: low scores → email-only
 *
 * The key insight: keyword match tells you the job *title* is relevant.
 * Fit score tells you whether *you* are relevant to the job.
 * A logistics coordinator role with "remote" in the title matches keywords,
 * but if your background is enterprise software and you have no supply chain
 * experience, waking you up at 2am for it is noise, not signal.
 */

import { FIT_SCORING } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// SCORE A JOB AGAINST A PROFILE
// Returns { score, verdict, reasoning } or null on failure
// Fast path: if no profile stored, returns null (alerts proceed normally)
// ─────────────────────────────────────────────────────────────────────────────
export async function scoreFit(job, profile, anthropicKey) {
  if (!profile || !anthropicKey || !FIT_SCORING.enabled) return null;

  const systemPrompt = `You are a hiring expert scoring job fit for a candidate.
Given a candidate profile and a job posting summary, score how well the candidate fits.
Be concise and rigorous. Respond ONLY with valid JSON, no markdown.

JSON schema:
{
  "score": number (1-10, where 10 = near-perfect fit),
  "verdict": "string (3-5 words)",
  "reasoning": "string (1 sentence — the single most important factor)"
}`;

  const userMsg = `CANDIDATE PROFILE:
${JSON.stringify({
    headline: profile.headline,
    yearsExperience: profile.yearsExperience,
    industry: profile.industry,
    domain: profile.domain,
    epicModules: profile.epicModules,
    skills: profile.skills,
    targetRoles: profile.targetRoles,
    environments: profile.environments,
    matchStrengths: profile.matchStrengths,
    potentialGaps: profile.potentialGaps,
  }, null, 2)}

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'not specified'}
Environment: ${job.environment || 'not specified'}
Keyword matched: ${job.matchedKeyword || 'n/a'}
Keyword group: ${job._matchGroup || 'n/a'}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: FIT_SCORING.model,
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!res.ok) {
      console.warn('[STAT fit] API error:', res.status);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text ?? '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('[STAT fit] Scoring failed (non-critical):', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE A BATCH OF MATCHES
// Attaches fit scores to each match in place. Returns the same array
// with job.fitScore / job.fitVerdict / job.fitReasoning populated.
// Non-blocking: if scoring fails for a job, it proceeds without a score.
// ─────────────────────────────────────────────────────────────────────────────
export async function scoreBatch(matches, profile, anthropicKey) {
  if (!profile || !anthropicKey || !FIT_SCORING.enabled) return matches;

  // Score concurrently but cap at 5 parallel requests to stay polite
  const CONCURRENCY = 5;
  for (let i = 0; i < matches.length; i += CONCURRENCY) {
    const batch = matches.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ job, match }) => {
      job._matchGroup = match.label;
      const result = await scoreFit(job, profile, anthropicKey);
      if (result) {
        job.fitScore    = result.score;
        job.fitVerdict  = result.verdict;
        job.fitReasoning = result.reasoning;
      }
    }));
  }

  return matches;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPANY-AWARE PRIORITY
// For the Epic · Health System P1 group, check whether the job is actually
// from a health system or a consulting firm. Consulting firm matches are
// downgraded to P2 and rely on fit score to re-earn P1 treatment.
//
// Why this is in fit.js rather than the keyword matcher:
//   matchJob() runs on job.title + job.company and returns the first group match.
//   The company filter is a post-match adjustment — we know the keyword matched,
//   now we decide if the company context changes the priority.
// ─────────────────────────────────────────────────────────────────────────────
export function companyAwarePriority(job, match) {
  // Only applies to groups that define a companyFilter
  const filter = match.group?.companyFilter;
  if (!filter) return match.priority;

  const company = (job.company || '').toLowerCase();

  // If company name contains a consulting hint → downgrade to P2
  const isConsulting = filter.consulting_hints?.some(h => company.includes(h));
  if (isConsulting) return 2;

  // If company name contains a health system hint → keep P1
  const isHealthSystem = filter.health_system_hints?.some(h => company.includes(h));
  if (isHealthSystem) return 1;

  // Company name doesn't match either list — keep original priority.
  // Unknown companies get the benefit of the doubt; the fit score
  // will still gate the final push behavior.
  return match.priority;
}

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTIVE PRIORITY — applies fit score gate
// Returns the effective push priority after applying fit thresholds.
// Called by dispatchAlerts to decide whether a P1 keyword match actually
// gets the high-priority siren push.
//
// Logic:
//   No score → pass through unchanged (no profile stored yet)
//   score < min_score_for_push → email only (priority -1 = no push)
//   score < min_score_for_p1 AND keyword was P1 → downgrade to P2 push
//   otherwise → use original keyword priority
// ─────────────────────────────────────────────────────────────────────────────
export function effectivePriority(keywordPriority, fitScore) {
  if (fitScore == null) return keywordPriority;
  if (fitScore < FIT_SCORING.min_score_for_push) return -1; // email only
  if (keywordPriority === 1 && fitScore < FIT_SCORING.min_score_for_p1) return 2; // downgrade
  return keywordPriority;
}
