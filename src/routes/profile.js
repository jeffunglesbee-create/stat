import { json } from './_utils.js';
import { getStatStore, storeDel, loadRecentMatches } from '../store.js';
import { loadDoRegistry, loadProfile, saveProfile, loadMatchCounts } from '../state.js';
// generateAndStoreKeywords lives in index.js. Circular import safe — only
// referenced inside async handlers.
import { generateAndStoreKeywords } from '../index.js';

export async function handleProfile(request, url, env) {
  // GET /profile
  if (url.pathname === '/profile' && request.method === 'GET') {
    const profile = await loadProfile(env);
    if (!profile) return json({ stored: false });
    return json({ stored: true, profile });
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
        signal: AbortSignal.timeout(8000),
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
        signal: AbortSignal.timeout(8000),
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

  // POST /regenerate-keywords — regenerate profile-driven keyword list from stored profile
  if (url.pathname === '/regenerate-keywords' && request.method === 'POST') {
    const profile = await loadProfile(env).catch(() => null);
    if (!profile) return json({ error: 'No profile stored — upload resume first' }, 404);
    if (!env.GEMINI_KEY) return json({ error: 'GEMINI_KEY not configured' }, 503);
    const keywords = await generateAndStoreKeywords(profile, env);
    if (!keywords) return json({ error: 'Keyword generation failed' }, 500);
    return json({ ok: true, keywords, generatedFrom: profile.headline });
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


  return null;
}
