// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for src/routes/*.js
// ─────────────────────────────────────────────────────────────────────────────

export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
# deploy trigger 2026-06-16T17:25:29Z
