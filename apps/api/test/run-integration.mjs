// Starts Jest for the integration tests. Extra arguments are passed on to Jest, for example:
//   pnpm --filter @ops/api test:integration -- work-logs -t "idempotency"
//
// Why this file exists: the package script loads the root .env through the dotenv-cli shim, and
// that shim sets NODE_PATH to pnpm's hoisted store, where the Jest 29 packages of the mobile app
// live. Jest resolves its runner, test environment and sequencer by name and would pick the
// Jest 29 ones up through NODE_PATH, which fails with "Must use import to load ES Module" on the
// ESM-only NestJS packages. Starting Jest in a child process without NODE_PATH lets it find its
// own Jest 30 packages through the normal node_modules lookup.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
for (const name of Object.keys(env)) {
  // Environment variable names are case-insensitive on Windows.
  if (name.toUpperCase() === 'NODE_PATH') {
    delete env[name];
  }
}

const result = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    resolve(apiRoot, 'node_modules/jest/bin/jest.js'),
    '--config',
    resolve(apiRoot, 'jest.integration.config.mjs'),
    ...process.argv.slice(2),
  ],
  { cwd: apiRoot, env, stdio: 'inherit' },
);

if (result.error) {
  console.error(result.error.message);
}
process.exit(result.status ?? 1);
