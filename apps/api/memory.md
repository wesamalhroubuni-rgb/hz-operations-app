# apps/api memory

Package `@ops/api`. Last updated: 2026-10-12.

## Purpose

The REST API. It owns the PostgreSQL database and will own business rules, permissions, and the
audit trail. Both clients (web and mobile) talk only to this API.

## Current state

Phase 1 skeleton. It boots, validates its environment, and serves one endpoint.

- `GET /health` returns 200 `{ status: 'ok', database: 'up', timestamp }` when a `SELECT 1`
  succeeds, and 503 `{ status: 'error', database: 'down', timestamp }` when it fails. The body type
  is `HealthResponse` from `@ops/shared`.
- The Prisma schema has a generator and a datasource and **no models**. There is no
  `prisma/migrations` folder yet.
- No authentication, no permissions, no audit log, no business endpoints.
- 3 unit tests, all in `src/health/health.spec.ts`.

Verified on 2026-10-12 with the database down (503, process stays up). **Not yet verified**: 200
with the database up, and `db:migrate`, because PostgreSQL has never run on this machine.

## Key files

| File                                    | What it does                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/main.ts`                           | Validates the environment before Nest starts, enables CORS and shutdown hooks, listens.                      |
| `src/app.module.ts`                     | Imports `AppConfigModule`, `PrismaModule`, `HealthModule`.                                                   |
| `src/config/env.ts`                     | Zod schema for the environment, `validateEnv`, `logLevelsFrom`.                                              |
| `src/config/app-config.module.ts`       | Global module exposing `ConfigService<Env, true>`. Reads `process.env` only (`ignoreEnvFile: true`).         |
| `src/prisma/prisma.service.ts`          | The single Prisma client, using the `@prisma/adapter-pg` adapter. Connects lazily. `ping()` runs `SELECT 1`. |
| `src/prisma/prisma.module.ts`           | Global module exporting `PrismaService`.                                                                     |
| `src/health/`                           | Controller, service, module, and spec for `/health`.                                                         |
| `prisma/schema.prisma`                  | Generator `prisma-client`, output `../src/generated/prisma`, `moduleFormat = "cjs"`.                         |
| `prisma.config.ts`                      | Prisma 7 config. Attaches `DATABASE_URL` only when it is set, so `prisma generate` works without a `.env`.   |
| `jest.config.mjs`                       | ts-jest, `*.spec.ts` under `src`, maps `./x.js` imports to `./x` for the generated client.                   |
| `eslint.config.mjs`                     | Base config plus decorator parser options.                                                                   |
| `tsconfig.json` / `tsconfig.build.json` | NodeNext modules, decorators on. The build config excludes specs and sets `rootDir` to `src`.                |

`src/generated/` is the generated Prisma client. It is git-ignored and must never be edited.

## Environment variables

All six are required. Values come from the root `.env`.

| Variable                      | Rule                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`                | Must start with `postgres://` or `postgresql://`.              |
| `DATABASE_CONNECT_TIMEOUT_MS` | Positive integer, milliseconds.                                |
| `API_HOST`                    | Non-empty. `0.0.0.0` lets a phone on the same network connect. |
| `API_PORT`                    | Integer 1 to 65535.                                            |
| `CORS_ORIGINS`                | Comma-separated list of browser origins.                       |
| `LOG_LEVEL`                   | One of `verbose`, `debug`, `log`, `warn`, `error`, `fatal`.    |

If any is wrong, the process prints one line per variable and exits with code 1. The message names
variables and never prints their values.

## Scripts

Run from the repo root as `pnpm --filter @ops/api <script>`.

| Script        | Command                                                               |
| ------------- | --------------------------------------------------------------------- |
| `dev`         | `prisma generate`, then `nest start --watch` with the root `.env`     |
| `build`       | `prisma generate`, then `nest build` into `dist/`                     |
| `start`       | `node dist/main.js` with the root `.env`                              |
| `lint`        | `eslint .`                                                            |
| `typecheck`   | `prisma generate`, then `tsc --noEmit`                                |
| `test`        | `prisma generate`, then Jest through `node --experimental-vm-modules` |
| `db:generate` | `prisma generate`                                                     |
| `db:migrate`  | `prisma migrate dev` with the root `.env`                             |
| `db:studio`   | `prisma studio` with the root `.env`                                  |
| `postinstall` | `prisma generate`                                                     |

## Conventions

- One NestJS module per concern in `src/<concern>/`. Controllers handle HTTP only; logic lives in
  services.
- Read configuration through `ConfigService<Env, true>` with `{ infer: true }`. Do not read
  `process.env` outside `src/config/env.ts` and `src/main.ts`.
- A new environment variable goes into `envSchema` and into the root `.env.example`.
- Response and request shapes come from `@ops/shared`.
- The package is CommonJS (no `"type": "module"`). Relative imports have no `.js` extension.
- Classes injected through constructors must be value imports, not `import type`. The ESLint
  config is set up so `consistent-type-imports` leaves them alone.
- Tests are `*.spec.ts` next to the code, use `@nestjs/testing`, and mock `PrismaService`. Unit
  tests need no database and no `.env`.
- Never log a connection string. `HealthService` redacts anything shaped like a URL before logging.
- Platform modules (auth, permissions, audit log, notifications, configuration, AI layer) must not
  import Operations-specific modules. See [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Known issues

- `/health` logs an error on every call while the database is down. This is noisy if something
  polls it. Consider logging only on state change when monitoring is added.
- `/health` is public and reveals whether the database is up. Acceptable for development; review
  in Phase 8.
- The spec is titled `GET /health` but calls the controller directly; there is no HTTP-level test.
- NestJS 12 packages are ESM-only while this package is CommonJS. This relies on Node 24 loading
  ESM through `require`, and on the `--experimental-vm-modules` flag in the test script.
- Prisma is pinned to exactly `7.10.0` (`prisma`, `@prisma/client`, `@prisma/adapter-pg`). Upgrade
  all three together.
- From PowerShell, `pnpm exec dotenv ... -- <cmd>` drops the arguments after `--`. Use the package
  scripts, or call `node_modules\.bin\dotenv.cmd` directly for ad-hoc Prisma commands.
