Read CLAUDE.md and STANDARDS.md first. Then read HANDOFF.md for current state.

SESSION START · Type: D (Audit) · Scope: Full codebase optimization analysis

You are auditing the STAT codebase for optimizations. Your job is ANALYSIS ONLY — do NOT change any code. Write your findings to outbox/cc-optimization-audit.md for review in the chat session.

## What to examine

Read every file in src/ (index.js, adapters.js, enrich.js, config.js, store.js, notify.js, platform-do.js, salary.js, fit.js, maryland.js, batch.js, ui.html). Also read smoke.js, wrangler.toml, and scan scripts/ and .github/workflows/.

For each file, look for:

1. **Dead code** — exported functions never imported, variables assigned but never read, code paths that can never execute, commented-out blocks
2. **Duplication** — repeated patterns that should be a helper (e.g. request body parsing, Response construction, fetch-with-timeout)
3. **Missing safety** — fetch calls without timeouts/AbortController, unhandled promise rejections, missing error boundaries
4. **Structural debt** — files that are too large and should be split, routing that should be extracted, config that should be externalized
5. **Performance** — sequential operations that could be parallel, redundant KV/R2 reads, unnecessary serialization/deserialization
6. **Stale artifacts** — scripts never referenced by any workflow or doc, obsolete comments referencing removed features, smoke assertions that test the wrong thing

## Output format

Write to outbox/cc-optimization-audit.md with this exact structure:

```markdown
# STAT Optimization Audit
Generated: [date]
HEAD: [current commit hash]
Smoke: [current count]

## Summary
[2-3 sentence overview of codebase health and top findings]

## Optimizations by Priority

### P1 — High Impact (do these first)
For each item:
- **[Title]** — [file(s) affected]
  - What: [1-2 sentence description of the problem]
  - Evidence: [specific line numbers, counts, or code snippets]
  - Value: [what improves — readability, safety, performance, testability]
  - Effort: [S/M/L estimate]
  - Risk: [what could break]

### P2 — Medium Impact
[same format]

### P3 — Low Impact / Nice-to-have
[same format]

## Dead Code Inventory
[List every dead export, unreferenced script, obsolete comment block]

## Metrics
- Total lines: [count]
- Largest files: [top 5 with line counts]
- fetch() calls without timeout: [count and locations]
- Duplicate patterns: [count and description]
- console.log/error/warn in production: [count per file]
- Smoke assertions: [count, any duplicates found]
```

## Rules for this audit

- DO NOT CHANGE ANY CODE. This is analysis only.
- DO NOT INVENT problems. Every finding must cite specific line numbers.
- DO NOT recommend rewrites for the sake of rewrites. Each optimization must have a clear, concrete value statement.
- Be honest about risk — if an optimization could break something, say so.
- Distinguish between "this is wrong" and "this could be better." Both are valid but they're different priorities.
- If something looks unusual but has a comment explaining why, respect the comment. It probably exists for a reason.
- Check docs/STAT-COMMITMENTS.txt and docs/STAT-CLAUDE-REVIEW.txt for architectural constraints before recommending changes that violate them.

## When done

1. Write the full audit to outbox/cc-optimization-audit.md
2. git add outbox/cc-optimization-audit.md
3. git commit -m "audit: full codebase optimization analysis [skip ci]"
4. git push
5. Update HANDOFF.md to note the audit was completed

Do not do any other work. The chat session will review your findings and decide what to implement.
