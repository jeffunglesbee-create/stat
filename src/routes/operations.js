import { json } from './_utils.js';
import { getStatStore, storeGet, storeSet, storeDel, readLog } from '../store.js';
// runHiringCafeScrape and jobhive CSV helpers live in index.js (also used by
// the cron handler). Circular import is safe because these bindings are only
// used inside async handlers, not at module init.
import {
  runHiringCafeScrape,
  splitCSVRows, parseCSVRow, cleanDesc, matchesEpicTerms,
} from '../index.js';

export async function handleOperations(request, url, env) {
  // POST /trigger — manual HiringCafe scrape
  if (url.pathname === '/trigger' && request.method === 'POST') {
    const count = await runHiringCafeScrape(env);
    return json({ ok: true, newMatches: count, time: new Date().toISOString() });
  }

  // GET /jobhive-scan?ats=workday&maxBytes=52428800&limit=500
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

      const dateKeys = Object.keys(by_date ?? {}).sort().slice(-3);
      const recentDeltas = dateKeys.map(d => ({
        date: d,
        rows: by_date[d].rows,
        size_mb: +(by_date[d].size_bytes/1e6).toFixed(2),
        csv: by_date[d].csv ?? null,
        parquet: by_date[d].parquet ?? null,
      }));

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
  if (url.pathname === '/logs' && request.method === 'GET') {
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const qAts   = url.searchParams.get('ats');
    let entries  = await readLog(getStatStore(env), 200);
    if (qAts) entries = entries.filter(e => e.ats === qAts);
    entries = entries.slice(0, limit);
    return json(entries);
  }

  // POST /reset-seen — clear global seen IDs
  if (url.pathname === '/reset-seen' && request.method === 'POST') {
    const stub = getStatStore(env);
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

  return null;
}
