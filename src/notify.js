/**
 * STAT — Matcher + Notifier
 */

import { WATCH_GROUPS, ENVIRONMENTS, GHOST } from './config.js';
import { effectivePriority } from './fit.js';

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD MATCHER
// Returns { group, priority, label, matchedKw } or null
// ─────────────────────────────────────────────────────────────────────────────
export function matchJob(job) {
  const haystack = `${job.title} ${job.company}`.toLowerCase();
  for (const group of WATCH_GROUPS) {
    for (const kw of group.keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        return { group, priority: group.priority, label: group.label, matchedKw: kw };
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT FILTER
// Returns true if the job passes the environment filter
// ─────────────────────────────────────────────────────────────────────────────
export function passesEnvFilter(job) {
  if (!ENVIRONMENTS || ENVIRONMENTS.length === 0) return true;
  if (!job.environment) return true; // unknown — let it through, don't suppress
  const envs = Array.isArray(ENVIRONMENTS) ? ENVIRONMENTS : [ENVIRONMENTS];
  return envs.some(e => job.environment.toLowerCase().includes(e.toLowerCase()));
}

// ─────────────────────────────────────────────────────────────────────────────
// GHOST AGE LABEL
// Returns a human-readable age string for inclusion in alerts
// ─────────────────────────────────────────────────────────────────────────────
export function ghostLabel(job) {
  if (!job.ghostFlag) return null;
  if (job.ghostFlag === 'suppress') return null; // caller should have filtered this
  // 'warn'
  return `⚠️ ${job.daysAgo}d old — verify still open`;
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB URL LIVENESS CHECK
// HEAD request on the job's apply URL before alerting.
// Returns: 'live' | 'dead' | 'unknown'
//
// 'live'    — URL returned 200/301/302 → confirmed active, alert fires
// 'dead'    — URL returned 4xx → job removed from ATS, suppress alert,
//             do NOT add to seen-set (re-evaluates next poll in case transient)
// 'unknown' — fetch failed (timeout, network, 5xx) → let alert through with
//             a note; better to false-positive than silently drop a real match
//
// Why this beats HiringCafe: they confirm jobs at crawl time (up to 12hr ago).
// STAT confirms the URL is live at the moment the alert fires.
//
// Timeout: 4s — fast enough to not block the DO alarm loop, long enough for
// slow ATS endpoints (Taleo / Workday SSR can be sluggish).
// ─────────────────────────────────────────────────────────────────────────────
export async function checkJobLiveness(job) {
  if (!job.url) return 'unknown';

  // iCIMS sitemap-discovered jobs may have partial titles with no meaningful
  // detail URL yet — skip liveness check, treat as unknown
  if (job.atsSource === 'icims' && !job.title) return 'unknown';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);

  try {
    // Use HEAD first — avoids downloading body, much faster
    const res = await fetch(job.url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (res.status >= 400 && res.status < 500) return 'dead';
    if (res.status >= 200 && res.status < 400) return 'live';
    // 5xx, etc. → unknown
    return 'unknown';

  } catch (e) {
    clearTimeout(timeout);
    // AbortError = timeout; TypeError = network failure
    // Both → unknown (don't suppress, can't confirm either way)
    return 'unknown';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUSHOVER NOTIFICATION
// priority: -2 silent | -1 quiet | 0 normal | 1 high (bypasses DnD) | 2 emergency
// ─────────────────────────────────────────────────────────────────────────────
export async function sendPushover(env, { title, message, url, urlTitle, priority }) {
  if (!env.PUSHOVER_APP_TOKEN || !env.PUSHOVER_USER_KEY) return;
  const body = new URLSearchParams({
    token:     env.PUSHOVER_APP_TOKEN,
    user:      env.PUSHOVER_USER_KEY,
    title:     title.slice(0, 250),
    message:   message.slice(0, 1024),
    url:       url ?? '',
    url_title: urlTitle ?? 'View Job',
    priority:  String(priority ?? 0),
    sound:     priority >= 1 ? 'siren' : 'pushover',
    ...(priority === 2 ? { retry: '60', expire: '3600' } : {}),
  });
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST', body,
    });
    const data = await res.json();
    if (data.status !== 1) console.error('Pushover error:', JSON.stringify(data));
  } catch (e) { console.error('Pushover failed:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDGRID EMAIL
// ─────────────────────────────────────────────────────────────────────────────
export async function sendEmail(env, { subject, htmlBody }) {
  if (!env.SENDGRID_API_KEY || !env.ALERT_EMAIL) return;
  const payload = {
    personalizations: [{ to: [{ email: env.ALERT_EMAIL }] }],
    from: { email: env.ALERT_EMAIL, name: 'STAT Job Watcher' },
    subject,
    content: [{ type: 'text/html', value: htmlBody }],
  };
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('SendGrid error:', res.status, await res.text());
  } catch (e) { console.error('Email failed:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL HTML BUILDER
// ─────────────────────────────────────────────────────────────────────────────
export function buildEmailHtml(newMatches) {
  const priorityColor = (p) => p === 1 ? '#dc2626' : p === 2 ? '#d97706' : '#16a34a';
  const priorityBg    = (p) => p === 1 ? '#fef2f2' : p === 2 ? '#fffbeb' : '#f0fdf4';

  const rows = newMatches.map(({ job, match }) => {
    const fitRow = (() => {
      if (job.fitScore == null) return '';
      const color = job.fitScore >= 8 ? '#16a34a' : job.fitScore >= 6 ? '#d97706' : '#dc2626';
      return `<div style="color:${color};font-size:12px;margin-top:4px;font-weight:600">Fit: ${job.fitScore}/10 — ${job.fitVerdict || ''}<span style="color:#64748b;font-weight:400"> · ${job.fitReasoning || ''}</span></div>`;
    })();
    const mdRow = (() => {
      if (!job.mdBadge) return '';
      const color = job.mdBadge.includes('likely')   ? '#1a6b6b'
                  : job.mdBadge.includes('possible') ? '#6b5200'
                  : '#8b2a2a';
      const bg    = job.mdBadge.includes('likely')   ? '#e8f4f4'
                  : job.mdBadge.includes('possible') ? '#faf5e8'
                  : '#f9eded';
      const detail = job.mdSignals?.length ? ` · ${job.mdSignals.join(', ')}` : '';
      return `<div style="color:${color};background:${bg};font-size:11px;margin-top:4px;padding:2px 8px;border-radius:3px;display:inline-block">${job.mdBadge}${detail}</div>`;
    })();
    const ghost = ghostLabel(job);
    const sal   = job.salary ? `<span style="color:#16a34a;font-weight:600">${job.salary}</span>` : '';
    const envBadge = job.environment
      ? `<span style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;margin-right:6px">${job.environment}</span>`
      : '';
    const pBadge = `<span style="background:${priorityBg(match.priority)};color:${priorityColor(match.priority)};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase">P${match.priority} · ${match.label}</span>`;
    const atsBadge = `<span style="background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600;text-transform:uppercase;margin-left:6px">${job.atsSource}</span>`;
    const ghostRow = ghost ? `<div style="color:#d97706;font-size:12px;margin-top:4px">${ghost}</div>` : '';
    const daysRow  = job.daysAgo !== null && !ghost
      ? `<div style="color:#94a3b8;font-size:11px;margin-top:2px">Posted ${job.daysAgo}d ago</div>` : '';
    const livenessRow = job.liveness === 'unknown'
      ? `<div style="color:#f59e0b;font-size:11px;margin-top:2px">⚡ URL unconfirmed — verify before applying</div>` : '';
    // Salary display — disclosed vs inferred, with transparency violation flag
    const salaryDisplay = (() => {
      if (job.transparencyViolation) {
        return `<div style="color:#8b2a2a;font-size:11px;margin-top:3px">⚠ No salary disclosed · legally required in ${job.transparencyFlag}</div>`;
      }
      if (!job.salary) return '';
      const inferredNote = job.salaryInferred && job.salaryLabel
        ? `<div style="color:#7a6e5e;font-size:10px;margin-top:1px;font-family:monospace">${job.salaryLabel}</div>`
        : '';
      const salaryColor = job.salaryInferred ? '#6b5200' : '#16a34a';
      const salaryPrefix = job.salaryInferred ? '~' : '';
      return `<div style="color:${salaryColor};font-weight:600;font-size:13px;margin-top:3px">${salaryPrefix}${job.salary}</div>${inferredNote}`;
    })();

    return `
      <tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:16px 0">
          <div style="margin-bottom:6px">${pBadge}${atsBadge}</div>
          <div style="font-size:17px;font-weight:700;margin-bottom:4px">
            <a href="${job.url}" style="color:#1a1a1a;text-decoration:none">${job.title}</a>
          </div>
          <div style="color:#555;font-size:14px;margin-bottom:4px">
            ${job.company}${job.location ? ` · ${job.location}` : ''}
          </div>
          <div style="margin-bottom:6px">${envBadge}</div>
          ${salaryDisplay}
          ${fitRow}
          ${mdRow}
          ${ghostRow}${daysRow}${livenessRow}
          <a href="${job.url}" style="display:inline-block;background:#111;color:#fff;padding:7px 16px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;margin-top:8px">Apply Now →</a>
        </td>
      </tr>`;
  }).join('');

  const p1Count = newMatches.filter(m => m.match.priority === 1).length;
  const hsCount = newMatches.filter(m => m.match.label?.includes('Health System')).length;
  const consultCount = newMatches.filter(m => m.match.label?.includes('Consulting')).length;
  const headline = p1Count > 0
    ? `${p1Count} P1 match${p1Count > 1 ? 'es' : ''}${hsCount ? ` · ${hsCount} health system` : ''}${consultCount ? ` · ${consultCount} consulting` : ''}`
    : `${newMatches.length} new match${newMatches.length > 1 ? 'es' : ''}`;

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;background:#fff">
      <div style="background:#0f172a;color:#fff;padding:24px 28px">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:8px">STAT · Job Intelligence</div>
        <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px">${headline}</div>
        <div style="color:#94a3b8;font-size:13px;margin-top:4px">${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</div>
      </div>
      <div style="padding:0 28px">
        <table style="width:100%;border-collapse:collapse">${rows}</table>
      </div>
      <div style="padding:20px 28px;background:#f8fafc;color:#94a3b8;font-size:11px;margin-top:16px">
        STAT monitors ${newMatches[0]?.job?.atsSource ? 'direct ATS sources' : 'HiringCafe + direct ATS sources'} — all jobs confirmed live at the source.
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH ALERTS for a batch of new matches
// Handles Pushover priority routing + email digest
// ─────────────────────────────────────────────────────────────────────────────
export async function dispatchAlerts(env, newMatches) {
  if (newMatches.length === 0) return;

  newMatches.sort((a, b) => a.match.priority - b.match.priority);

  const p1    = newMatches.filter(m => effectivePriority(m.match.priority, m.job.fitScore) === 1);
  const p2p3  = newMatches.filter(m => effectivePriority(m.match.priority, m.job.fitScore) >= 2);

  // P1: one push per job — high priority, bypasses quiet hours
  for (const { job, match } of p1) {
    const sal = (() => {
      if (!job.salary) return '';
      const prefix = job.salaryInferred ? ' · ~' : ' · ';
      return `${prefix}${job.salary}`;
    })();
    const env2  = job.environment ? ` · ${job.environment}` : '';
    const ghost = ghostLabel(job);
    const ghostLine = ghost ? `\n${ghost}` : '';
    const unverLine = job.liveness === 'unknown' ? '\n⚡ URL unconfirmed — verify before applying' : '';
    const fitLine = job.fitScore != null ? `\nFit: ${job.fitScore}/10 — ${job.fitVerdict || ''}` : '';
    const mdLine  = job.mdBadge ? `\n${job.mdBadge}` : '';
    await sendPushover(env, {
      title:    `🚨 STAT P1: ${match.label}`,
      message:  `${job.title}\n${job.company}${job.location ? ' · ' + job.location : ''}${env2}${sal}${fitLine}${mdLine}${ghostLine}${unverLine}`,
      url:      job.url,
      urlTitle: 'Apply Now',
      priority: 1,
    });
  }

  // P2/P3: single batched push
  if (p2p3.length > 0) {
    const lines = p2p3
      .map(({ job, match }) => {
        const ghost = ghostLabel(job);
        const fitNote = job.fitScore != null ? ` [${job.fitScore}/10]` : '';
        return `[P${match.priority}] ${job.title} @ ${job.company}${fitNote}${ghost ? ' ' + ghost : ''}`;
      })
      .join('\n');
    await sendPushover(env, {
      title:    `📋 STAT: ${p2p3.length} new match${p2p3.length > 1 ? 'es' : ''}`,
      message:  lines,
      url:      'https://hiring.cafe',
      urlTitle: 'Open HiringCafe',
      priority: 0,
    });
  }

  // Email: one digest for all matches
  await sendEmail(env, {
    subject:  `[STAT] ${newMatches.length} new match${newMatches.length > 1 ? 'es' : ''} — ${newMatches[0].job.title} @ ${newMatches[0].job.company}`,
    htmlBody: buildEmailHtml(newMatches),
  });
}
