// Copies the versioned AI prompt files (src/operations/ai/prompts/*.md, ADR-0010) next to
// compiled code that tsc produced without the nest build's asset step (the seed build):
//   node scripts/copy-prompts.mjs node_modules/.cache/ops-seed
// The nest build copies them itself (`assets` in nest-cli.json).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node scripts/copy-prompts.mjs <compiled output folder>');
  process.exit(1);
}
const source = resolve(apiRoot, 'src/operations/ai/prompts');
const target = resolve(apiRoot, outDir, 'operations/ai/prompts');
mkdirSync(target, { recursive: true });
if (existsSync(source)) {
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !/\.[^/\\]+$/.test(path) || path.endsWith('.md'),
  });
}
