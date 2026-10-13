# apps/api memory

Package `@ops/api`. Last updated: 2026-10-13.

## Purpose

The REST API. It owns the PostgreSQL database, the business rules, the audit trail, and the event
outbox, and will own authentication and permissions. Both clients (web and mobile) talk only to
this API.

## Current state

Phase 2 backend core, code complete on 2026-10-13.

- **38 paths** over organization, users, memberships, sites, teams, log types, tasks, work logs,
  attachment metadata, scope, audit events, outbox events, and health. The full list and the HTTP
  conventions are in [ARCHITECTURE.md](../../ARCHITECTURE.md).
- **Data model**: 14 Prisma models, two migrations, UUIDv7 ids, PostgreSQL enums.
- **Every write** is one transaction: business row, audit event, outbox event, through
  `ChangeRecorder`.
- **Scope resolution** exists as a pure function and a service, exposed for inspection. **Nothing
  enforces it.**
- **No authentication.** The acting user comes from the TEMPORARY `x-dev-user-id` header (see
  below). Any acting user can read and change everything in their organization.
- **Attachments are metadata only.** `FileStorage` is an interface with no provider.
- **Swagger** at `/docs`, `/docs-json`, `/docs-yaml`, in development only.
- **Tests**: 500 unit tests in 7 suites; 532 integration tests in 9 suites.

Verified on 2026-10-13: lint, typecheck, unit tests, integration tests, and build pass; both
migrations applied to the development database; the seed ran once; the API boots in development
and serves data with the dev header; boot is refused with `DEV_AUTH_ENABLED=true` under
`production`, `test`, and unset `NODE_ENV`. **Not verified**: `db:reset` has never been executed.

## Layout

```text
src/
  main.ts                 boot: env, x-powered-by off, request context, CORS, Swagger (dev), listen
  app.module.ts           AppConfig, Prisma, Platform, Health, Operations
  config/                 env.ts (Zod schema, validateEnv), app-config.module.ts
  prisma/                 PrismaService (lazy connection, adapter-pg), PrismaModule
  health/                 GET /health, the only @Public() route
  platform/               REUSABLE. Must not import src/operations (ESLint error)
    platform.module.ts    global: middleware, exception filter, guard, audit and outbox controllers
    request-context/      RequestContext (AsyncLocalStorage), middleware, correlation id, request log
    http/                 ApiException, ApiExceptionFilter, ZodPipe, ApiDocs, pagination, filters,
                          requireActor, @Public(); index.ts re-exports them
    audit/                AuditService (writer), audit-snapshot (diff, redaction), AuditQueryService,
                          AuditEventsController
    outbox/               OutboxService (publish, readAfter, markProcessed), OutboxQueryService,
                          OutboxEventsController
    dev-auth/             TEMPORARY: DevActorGuard, isDevAuthEnabled
    docs/                 Swagger setup
  operations/             the Operations domain
    operations.module.ts
    common/               ChangeRecorder, references.ts, hierarchy.ts, db.ts
    organization/ users/ memberships/ sites/ teams/ log-types/ tasks/ work-logs/ attachments/
                          each: *.controller.ts, *.service.ts, *.module.ts
    scope/                resolve-scope.ts (pure), scope.service.ts, scope.controller.ts
    storage/              file-storage.ts (interface and token only)
    seed/                 demo-seed.ts
  generated/              Prisma client. Git-ignored. Never edit
prisma/
  schema.prisma
  migrations/             20261013112952_init, 20261013150000_attachment_storage_key_per_org
  seed.ts                 entry point of the seed
test/
  *.int-spec.ts           integration suites
  support/                test-database.ts (the safety guard), test-app.ts, factories.ts, setup files
  run-integration.mjs     starts Jest without NODE_PATH
```

## Key files

| File                                            | What it does                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/env.ts`                             | Environment schema. Also refuses `DEV_AUTH_ENABLED=true` outside `NODE_ENV=development`.                                                 |
| `src/platform/platform.module.ts`               | Registers everything the platform provides, for the whole app.                                                                           |
| `src/platform/request-context/`                 | Correlation id from `x-request-id` (or a new UUID), the actor, and one JSON log line per request.                                        |
| `src/platform/http/api-exception.ts`            | `ApiException.validation / unauthenticated / forbidden / notFound / conflict / unprocessable`. The only exception services should throw. |
| `src/platform/http/api-exception.filter.ts`     | Turns anything thrown into the standard error body. Maps Prisma `P2002` to 409, `P2003` to 422, `P2025` to 404.                          |
| `src/platform/http/zod.pipe.ts`                 | Validates body, query, and params against a schema from `@ops/shared`. Unknown keys become one detail each.                              |
| `src/platform/http/api-docs.decorator.ts`       | `@ApiDocs({ summary, body, query, response, status, errors })`: OpenAPI from the same Zod schemas.                                       |
| `src/platform/http/filters.ts`                  | `nameFilter` (exact or prefix), `escapeLike`, `dateRangeFilter` (inclusive from, exclusive to).                                          |
| `src/platform/audit/audit.service.ts`           | `record(tx, input)`: one audit row with redacted `before`, `after`, and `changes`.                                                       |
| `src/platform/audit/audit-snapshot.ts`          | JSON snapshot, top-level diff, and `DEFAULT_REDACTED_KEY_PATTERN`.                                                                       |
| `src/platform/outbox/outbox.service.ts`         | `publish(tx, input)`, plus `readAfter` and `markProcessed` for the future consumer.                                                      |
| `src/platform/dev-auth/dev-actor.guard.ts`      | TEMPORARY global guard: sets the actor from the dev header, or answers 401.                                                              |
| `src/operations/common/change-recorder.ts`      | `record(tx, change)`: writes the audit event and the outbox event of one change, both named `<entityType>.<verb>`.                       |
| `src/operations/common/references.ts`           | `assertActiveReferences` (ids belong to the organization and are not archived, else 422) and `assertValidParent` (no cycles).            |
| `src/operations/scope/resolve-scope.ts`         | The scope rules, as a pure function with the rules in its comment.                                                                       |
| `src/operations/work-logs/work-logs.service.ts` | Idempotent create on `clientId`, custom-field validation, `logTypeVersion`.                                                              |
| `src/operations/seed/demo-seed.ts`              | The demo data and `seedDemo(app)`.                                                                                                       |
| `prisma.config.ts`                              | Prisma 7 config. Attaches `DATABASE_URL` only when set, so `prisma generate` works without `.env`.                                       |
| `jest.config.mjs`                               | Unit tests: `*.spec.ts` under `src`.                                                                                                     |
| `jest.integration.config.mjs`                   | Integration tests: `*.int-spec.ts` under `test`, one worker, global setup that creates and migrates the test database.                   |
| `eslint.config.mjs`                             | Base config, decorator parser options, and the rule that forbids `src/platform` importing `src/operations`.                              |
| `nest-cli.json`                                 | `deleteOutDir: true`: every `nest build` wipes `dist/`.                                                                                  |

## The dev header (TEMPORARY, removed in Phase 3)

- Header: `x-dev-user-id`, a user id (UUID). The constant is `DEV_USER_HEADER` in `@ops/shared`.
- Honoured only when `NODE_ENV === 'development'` and `DEV_AUTH_ENABLED === true`
  (`isDevAuthEnabled`, a pure function with its truth table tested).
- `env.ts` refuses to boot with the flag in any other `NODE_ENV`; unset `NODE_ENV` is `production`.
- The guard re-checks independently. Off: every non-public route is a 401 and the header is not
  read. On: the header must name an existing, non-archived user, who becomes
  `RequestContext.actor()` (`{ userId, organizationId }`). The guard logs a warning at startup.
- The integration tests replace `AppConfigModule` with a fake `ConfigService` that answers
  `NODE_ENV: 'development'`, `DEV_AUTH_ENABLED: true`, because Jest runs with `NODE_ENV=test`.
- To remove in Phase 3: this folder, the `APP_GUARD` line in `platform.module.ts`, the env
  variable and its refinement, the `devUserHeader` option in `docs/api-docs.setup.ts`, the header
  in the CORS `allowedHeaders` in `main.ts`, and `DEV_USER_HEADER` in `@ops/shared`.

## Environment variables

Values come from the root `.env`, except `NODE_ENV`, which the scripts set.

| Variable                      | Rule                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | `development`, `test`, or `production`. Optional; defaults to `production`. Set by scripts.    |
| `DEV_AUTH_ENABLED`            | `true` or `false`. Optional; defaults to `false`. `true` is allowed only in `development`.     |
| `DATABASE_URL`                | Required. Must start with `postgres://` or `postgresql://`.                                    |
| `DATABASE_CONNECT_TIMEOUT_MS` | Required. Positive integer, milliseconds.                                                      |
| `API_HOST`                    | Required. `127.0.0.1` in `.env.example`. `0.0.0.0` only for a phone test on a trusted network. |
| `API_PORT`                    | Required. Integer 1 to 65535.                                                                  |
| `CORS_ORIGINS`                | Required. Comma-separated list of browser origins.                                             |
| `LOG_LEVEL`                   | Required. One of `verbose`, `debug`, `log`, `warn`, `error`, `fatal`.                          |
| `DATABASE_URL_TEST`           | Read only by the integration tests. Database name must end in `_test`.                         |

If any is wrong, the process prints one line per variable and exits with code 1. The message names
variables and never prints their values.

## Scripts

Run from the repo root as `pnpm --filter @ops/api <script>`. The root has shortcuts for
`db:migrate`, `db:seed`, `db:reset`, and `test:integration` that build `@ops/shared` first where
needed.

| Script             | Command                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `dev`              | `prisma generate`, then `nest start --watch` with the root `.env` and `NODE_ENV=development`                     |
| `build`            | `prisma generate`, then `nest build` into `dist/` (deletes `dist/` first)                                        |
| `start`            | `node dist/main.js` with the root `.env` and `NODE_ENV=production`                                               |
| `lint`             | `eslint .`                                                                                                       |
| `typecheck`        | `prisma generate`, then `tsc --noEmit`                                                                           |
| `test`             | `prisma generate`, then Jest through `node --experimental-vm-modules`                                            |
| `test:integration` | `prisma generate`, then `node test/run-integration.mjs` with the root `.env`                                     |
| `db:generate`      | `prisma generate`                                                                                                |
| `db:migrate`       | `prisma migrate dev` with the root `.env`                                                                        |
| `db:deploy`        | `prisma migrate deploy` with the root `.env`                                                                     |
| `db:seed`          | `prisma generate`, compile `src` into `node_modules/.cache/ops-seed`, then `tsx prisma/seed.ts` in `development` |
| `db:reset`         | `prisma migrate reset --force`, then `db:seed`. **Never executed so far. Not for agents.**                       |
| `db:studio`        | `prisma studio` with the root `.env`                                                                             |
| `postinstall`      | `prisma generate`                                                                                                |

## Seed

- `pnpm db:seed` creates the organization "HZ Demo" (slug `hz-demo`) with 2 sites (North Depot,
  Harbour Project), 3 teams (Electrical, Maintenance, Logistics), 10 users with 10 memberships
  (1 admin and 1 manager, both organization-wide; 2 supervisors, one scoped to a site and one to a
  site plus a team; 6 workers, one of them in two teams), 3 log types (Inspection, Delivery,
  Material usage), 8 tasks, and 25 work logs over 14 days.
- It is idempotent on the slug: if the organization exists, nothing is written. A seed that
  stopped halfway therefore stays incomplete until the database is reset.
- Everything except the organization row goes through the real services, so validation runs and
  audit and outbox rows are written (81 of each), with the `system` actor because there is no
  request.
- The seed compiles the API with `tsc` into `node_modules/.cache/ops-seed` because the services
  need decorator metadata, which `tsx` does not emit, and because `dist/` belongs to a running
  dev server.
- Names are invented and emails use `example.com`. User ids change on every reset; the seed
  prints them. Task `createdAt` is the seed time for every task; only `dueAt` is spread.

## Tests

- **Unit** (`pnpm --filter @ops/api test`): `src/**/*.spec.ts`, 7 suites, 500 tests. No database,
  no `.env`. Covers the environment schema, health, scope resolution, the dev-auth policy and
  guard, `ZodPipe`, and the platform modules.
- **Integration** (`pnpm test:integration`): `test/*.int-spec.ts`, 9 suites, 532 tests, about 45
  seconds. The real Nest application is booted in-process on an ephemeral port of `127.0.0.1` and
  called over HTTP. Suites: `harness`, `auth-and-errors`, `org-structure`, `log-types`, `tasks`,
  `work-logs`, `audit-outbox-transaction`, `audit-outbox-read`, `tenant-isolation`.
- **The safety guard** is `resolveTestDatabase` in `test/support/test-database.ts`. It refuses to
  run unless `DATABASE_URL_TEST` is set, its database name ends in `_test`, and that name differs
  from the one in `DATABASE_URL`. `truncateAll` additionally asks the server which database it is
  on before truncating. The global setup creates the database when missing and applies the
  migrations with `prisma migrate deploy`.
- The suites share one database and truncate it between tests, so they run with one worker.
- `run-integration.mjs` exists because the dotenv-cli shim sets `NODE_PATH` to pnpm's hoisted
  store, where the mobile app's Jest 29 packages live; Jest 30 would load them and fail. Its
  comment says extra arguments are passed to Jest (`-- work-logs -t "..."`); that has not been
  tried from PowerShell.

## Conventions

- Controllers handle HTTP only: `ZodPipe` on every input, `requireActor()` for the organization,
  one service call. Rules and transactions live in services.
- Every write follows the pattern in `ChangeRecorder`'s comment: inside `prisma.$transaction`,
  load the row, check references, write, then `changes.record(tx, ...)`. Pass the wire-shape
  (`toXxx`) objects as `before` and `after`.
- A no-op write (archive an archived record, same status, same assignees, retried `clientId`)
  returns the record and records nothing.
- `find` throws 404 for a missing or other-organization record; `findActive` adds 409 for an
  archived one.
- Take `organizationId` from the actor. Never from the body or the URL.
- New entity types go into `EntityType` and `PAYLOAD_KEYS` in `change-recorder.ts`, and into
  `ReferenceKind` in `references.ts` if other records can point at them.
- Platform code writes through narrow structural types (`AuditWriter`, `OutboxWriter`), not the
  generated Prisma types, and states its host requirements in a header comment.
- Read configuration through `ConfigService`. Do not read `process.env` outside
  `src/config/env.ts` and `src/main.ts`.
- A new environment variable goes into `envSchema`, the root `.env.example`, and
  `globalPassThroughEnv` in `turbo.json`.
- The package is CommonJS (no `"type": "module"`). Relative imports have no `.js` extension.
- Classes injected through constructors must be value imports, not `import type`.
- Unit tests are `*.spec.ts` next to the code. Every new endpoint also gets integration tests,
  including the tenant-isolation case (404 for another organization's id, 422 for its id in a
  body).
- Never log a connection string, a request body, a header, or a query value.

## Known issues

- **No permission enforcement and trusting bodies.** Any user can set `authorId`, create or move
  a work log to `approved`, edit an approved log, set any status from any status, and get any
  user's stored log back by retrying its `clientId`. Phase 3.
- **Audit and outbox reads are open to every user of the organization** and contain full
  snapshots (email, phone, text, GPS).
- **Redaction is by key name.** A custom field keyed `token_no` or `batch_hash` is redacted in
  audit and outbox events. The outbox always uses the default pattern; `AUDIT_OPTIONS` affects
  only the audit log.
- **The append-only trigger does not block `TRUNCATE`.**
- **No optimistic locking.** Concurrent updates are last-write-wins and can record a stale
  `before`.
- **Outbox sequences are assigned at insert, not commit.** See the comment on `readAfter`.
- **The client supplies the attachment `storageKey`.** The API must generate it, prefixed with the
  organization id, before a provider is bound (Phase 4).
- **`db:reset` has no guard on its target database.**
- Scope resolution loads every membership, site, and team of the organization per call.
- Old log type definitions are recoverable only from the audit log.
- Memberships, log types, tasks, work logs, and attachments have no restore endpoint.
- Tenancy is enforced in application code only.
- `/health` logs an error on every call while the database is down, is public, and reveals
  whether the database is up.
- `nest build` deletes `dist/` under a running dev server.
- The Swagger description in `main.ts` and the `description` in `package.json` still say
  "Operations App".
- NestJS 12 packages are ESM-only while this package is CommonJS. This relies on Node 24 loading
  ESM through `require`, and on the `--experimental-vm-modules` flag in the test scripts.
- Prisma is pinned to exactly `7.10.0` (`prisma`, `@prisma/client`, `@prisma/adapter-pg`). Upgrade
  all three together.
- From PowerShell, `pnpm exec dotenv ... -- <cmd>` drops the arguments after `--`. Use the package
  scripts, or call `node_modules\.bin\dotenv.cmd` directly for ad-hoc Prisma commands.
