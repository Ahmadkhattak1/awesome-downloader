// Fails the build if the staged legacy sources use syntax/APIs a Node 16 / Chromium 108 runtime lacks.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const stage = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stage');
const banned = [[/\bfetch\(/, 'global fetch'], [/(?:from\s+|require\()['"]googlevideo/, 'googlevideo import'], [/\.(toSorted|toReversed|toSpliced|findLastIndex)\(/, 'ES2023 array method'], [/AbortSignal\.timeout/, 'AbortSignal.timeout'], [/Promise\.withResolvers|Object\.groupBy|Array\.fromAsync/, 'ES2024 API']];
const problems = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(full); continue; }
    if (!/\.(mjs|cjs|js)$/.test(entry.name) || full.includes(`${path.sep}extension${path.sep}`)) continue;
    const text = await fs.readFile(full, 'utf8');
    for (const [pattern, label] of banned) if (pattern.test(text)) problems.push(`${path.relative(stage, full)}: ${label}`);
  }
}
await walk(stage);
const manifest = JSON.parse(await fs.readFile(path.join(stage, 'extension', 'manifest.json'), 'utf8'));
if (JSON.stringify(manifest).includes('"world":"MAIN"')) problems.push('extension/manifest.json: world MAIN needs Chrome 111+');
if (problems.length) { console.error('Legacy compatibility problems:\n' + problems.join('\n')); process.exit(1); }
console.log('Legacy compatibility check passed.');
