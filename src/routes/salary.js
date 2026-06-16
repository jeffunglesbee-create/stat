import { json } from './_utils.js';
import { bootstrapSalaryDO } from '../salary.js';

export async function handleSalary(request, url, env) {
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

  // POST /salary-load-r2 — load LCA data from R2 into DO storage metadata.
  // Called after lca-refresh.yml CI workflow uploads to R2.
  // Does NOT fetch from DOL — reads only from R2 (already populated by CI).
  if (url.pathname === '/salary-load-r2' && request.method === 'POST') {
    try {
      const id   = env.SALARY_INFERENCE.idFromName('salary-inference');
      const stub = env.SALARY_INFERENCE.get(id);
      const res  = await stub.fetch(new Request('https://stat-salary/load-r2-lca', { method: 'POST' }));
      const data = await res.json();
      return json({ ok: true, ...data });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
