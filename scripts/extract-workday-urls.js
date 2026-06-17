#!/usr/bin/env node
// scripts/extract-workday-urls.js
//
// Extracts every { name, ats: 'workday', url } entry from src/config.js into
// a flat JSON list. Used by the Workday URL audit workflow + by local probes.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
const re = /\{\s*name:\s*'([^']+)'[^{}]*?ats:\s*'workday'[^{}]*?url:\s*'([^']+)'[^{}]*?\}/gs;
const out = [];
const seen = new Set();
let m;
while ((m = re.exec(src)) !== null) {
  const key = `${m[1]}|${m[2]}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({ name: m[1], url: m[2] });
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
