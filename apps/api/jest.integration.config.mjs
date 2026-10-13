/**
 * Integration tests: the real Nest application over HTTP against a real PostgreSQL database
 * (DATABASE_URL_TEST, never the development database). Run with `pnpm test:integration` from
 * the repository root. The unit tests (jest.config.mjs) need no database and stay separate.
 *
 * Start it through test/run-integration.mjs (which the package script does), not through
 * dotenv-cli directly: see the comment in that file.
 *
 * @type {import('jest').Config}
 */
const config = {
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testEnvironment: 'node',
  testRegex: '.*\\.int-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  // The generated Prisma client imports its own files as "./x.js" (they are .ts on disk).
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // Creates the test database when missing and applies the migrations (guarded: see
  // test/support/test-database.ts).
  globalSetup: '<rootDir>/test/support/global-setup.ts',
  setupFiles: ['<rootDir>/test/support/env-setup.ts'],
  // Every file truncates the one shared database, so the files must not run side by side.
  maxWorkers: 1,
  testTimeout: 30_000,
};

export default config;
