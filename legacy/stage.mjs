// Builds legacy/stage from the shared sources. The shared (64-bit) sources are only READ.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const stage = path.join(here, 'stage');
await fs.rm(stage, { recursive: true, force: true });
const skip = name => /\.test\.(mjs|cjs)$/.test(name) || name === 'node_modules';
for (const dir of ['desktop', 'core', 'renderer', 'assets', 'integration', 'extension', 'build', 'vendor'])
  await fs.cp(path.join(root, dir), path.join(stage, dir), { recursive: true, filter: source => !skip(path.basename(source)) });
// Legacy runtime substitutions.
await fs.copyFile(path.join(here, 'sabr.legacy.mjs'), path.join(stage, 'core', 'sabr.mjs'));
await fs.copyFile(path.join(stage, 'extension', 'manifest.legacy.json'), path.join(stage, 'extension', 'manifest.json'));
await fs.copyFile(path.join(here, 'CREDITS.md'), path.join(stage, 'CREDITS.md'));
for (const file of ['THIRD-PARTY.md', 'LICENSE']) await fs.copyFile(path.join(root, file), path.join(stage, file));
// ESM scope for core/*.mjs is by extension, but keep the stage self-describing.
console.log('Legacy stage ready:', stage);
