import UI_HTML from '../ui.html';
import { json } from './_utils.js';
import { BATCH_WATCHLIST } from '../config.js';
import { loadDoRegistry, loadSeenIds, loadCompanyList, loadProfile } from '../state.js';

// ─────────────────────────────────────────────────────────────────────────────
// UI ETAG — computed once at Worker startup (module load), never at request time.
// 32-bit hash of UI_HTML content. Changes on every deploy since UI_HTML is
// baked into the Worker bundle. Enables 304 Not Modified on repeat /ui opens.
// ─────────────────────────────────────────────────────────────────────────────
const UI_ETAG = (() => {
  let h = 0;
  for (let i = 0; i < UI_HTML.length; i++) {
    h = (Math.imul(31, h) + UI_HTML.charCodeAt(i)) | 0;
  }
  return '"' + (h >>> 0).toString(36) + '"';
})();

export async function handleUI(request, url, env) {
  // GET /ui — HTML dashboard (served inline from ui.html)
  // ETag-based caching: repeat opens return 304 (no body) instead of 85KB.
  // UI_ETAG is computed once at module load from UI_HTML content hash.
  // Cache-Control: max-age=0 forces revalidation on every open, but the
  // 304 path skips the body transfer entirely — fast on slow connections.
  if (url.pathname === '/ui' && request.method === 'GET') {
    if (request.headers.get('If-None-Match') === UI_ETAG) {
      return new Response(null, {
        status: 304,
        headers: { 'ETag': UI_ETAG, 'Cache-Control': 'max-age=0, must-revalidate' },
      });
    }
    return new Response(UI_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'max-age=0, must-revalidate',
        'ETag': UI_ETAG,
      },
    });
  }

  // GET / — redirect browsers to /ui, return JSON for API clients
  if (url.pathname === '/' && request.method === 'GET') {
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/html')) {
      return Response.redirect(new URL('/ui', request.url).toString(), 302);
    }
    const [registry, seenIds, companiesRaw, profile] = await Promise.all([
      loadDoRegistry(env),
      loadSeenIds(env),
      loadCompanyList(env),
      loadProfile(env),
    ]);
    const companies = companiesRaw ?? [];

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
        'POST /salary-load-r2':'Load LCA from R2 into DO storage (after CI upload)',
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

  return null;
}
