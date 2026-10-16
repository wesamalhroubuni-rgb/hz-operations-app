# apps/api memory

Package `@ops/api`. Last updated: 2026-10-16.

## Purpose

The REST API. It owns the PostgreSQL database, the business rules, sign-in and sessions, the
permission rules, the audit trail, and the event outbox. Both clients (web and mobile) talk only to
this API.

## Current state

Phase 3 (authentication and permissions) code complete on 2026-10-16, uncommitted.

- **49 paths**: the Phase 2 resources, nine `/auth/*` routes, and
  `POST /users/:id/activation-code` and `POST /users/:id/password-reset`. The full list with the
  policy of each route, the HTTP conventions, and the permissions matrix are in
  [ARCHITECTURE.md](../../ARCHITECTURE.md).
- **Sign-in** (`src/platform/auth/`, ADR-0004): email, phone, or username plus password; JWT access
  tokens (15 minutes) and rotating refresh tokens with reuse detection; httpOnly cookies and CSRF
  for `web`, bearer tokens for `mobile`; argon2id; one-time activation and reset codes; rate limits
  and lockout; security audit events. Every request checks the session and the user in the
  database.
- **Authorization** (`src/operations/access/`, ADR-0005): one global guard applies the route's
  policy from the registry; services apply pure object-level rules and visibility filters from one
  definition per resource; role-shaped responses (users `basic` / `contact` / `full`,
  organization `summary` / `full`).
- **Data model**: 14 business models plus four auth tables, three migrations, UUIDv7 ids.
- **Every write** is one transaction: business row, audit event, outbox event, through
  `ChangeRecorder`. Auth security events go to the audit log only.
- **Attachments are metadata only.** `FileStorage` is an interface with no provider.
- **Swagger** at `/docs`, `/docs-json`, `/docs-yaml`, in development only, with a bearer scheme.
- **Tests**: 367 unit tests in 15 suites; 1,208 integration tests in 14 suites (about 150 s).

Verified in the Phase 3 session: lint, typecheck, unit and integration tests pass (2026-10-16);
the auth migration is applied to the development database; agents checked sign-in, CSRF, refresh
reuse, lockout, rate limits, the production boot refusal, and 37 permission cases over HTTP.
**Not verified**: `pnpm build` in the final pass; `pnpm db:reset` (never executed) and therefore
the Phase 3 seed on the development database.

## Layout

```text
src/
  main.ts                 boot: env, x-powered-by off, trust proxy (TRUST_PROXY_HOPS), request
                          context, CORS with credentials, Swagger (dev), listen
  app.module.ts           AppConfig, Prisma, Platform, Health, Operations
  route-policies.spec.ts  every route has @Public/@Authenticated/a registered @Policy
  config/                 env.ts (Zod schema, validateEnv, production refusals), app-config.module.ts
  prisma/                 PrismaService (lazy connection, adapter-pg), PrismaModule
  health/                 GET /health (@Public)
  platform/               REUSABLE. Must not import src/operations (ESLint error)
    platform.module.ts    global: middleware, no-store on /auth, exception filter, AuthGuard,
                          auth/audit/outbox controllers, auth providers
    request-context/      RequestContext (AsyncLocalStorage: correlation id, actor), middleware
    http/                 ApiException (incl. rateLimited), filter, ZodPipe, ApiDocs, pagination,
                          filters, requireActor, @Public()
    auth/                 auth.guard.ts, auth.controller.ts, auth.service.ts, auth-admin.service.ts,
                          sessions.ts, access-token.ts, csrf.ts, auth-http.ts (cookies, Origin),
                          one-time-codes.ts, password-hasher.ts, password-policy.ts,
                          identifiers.ts, rate-limiter.ts, auth-settings.ts, auth-db.ts,
                          auth-profile.ts, hashing.ts, clock.ts
    authz/                @Policy, @Authenticated, @DevelopmentOnly, REQUEST_AUTHORIZER
    notifications/        NotificationSender, LoggingNotificationSender
    audit/                AuditService (writer), audit-snapshot (diff, redaction), query, controller
    outbox/               OutboxService, query, controller (@DevelopmentOnly)
    docs/                 Swagger setup (bearer and cookie schemes)
  operations/             the Operations domain
    operations.module.ts
    access/               policies.ts (registry), access.service.ts, access-context.ts,
                          decision.ts, visibility.ts, rules/*.rules.ts,
                          operations-request-authorizer.ts, operations-auth-profile.provider.ts,
                          access.module.ts (global), clock.ts, testing.ts
    common/               ChangeRecorder, references.ts, hierarchy.ts, db.ts
    organization/ users/ memberships/ sites/ teams/ log-types/ tasks/ work-logs/ attachments/
                          each: *.controller.ts, *.service.ts, *.module.ts
    memberships/admin-guard.ts   last-admin check under an advisory lock
    scope/                resolve-scope.ts (pure), scope.service.ts, scope.controller.ts
    storage/              file-storage.ts (interface and token only)
    seed/                 demo-seed.ts (DEV_PASSWORDS)
  generated/              Prisma client. Git-ignored. Never edit
prisma/
  schema.prisma
  migrations/             20261013112952_init, 20261013150000_attachment_storage_key_per_org,
                          20261014090000_auth
  seed.ts                 entry point of the seed
test/
  *.int-spec.ts           integration suites
  support/                test-database.ts (safety guard), test-app.ts (harness, sessions, fake
                          clock and notification sender), factories.ts, matrix-world.ts, setup
  run-integration.mjs     starts Jest without NODE_PATH
```

## Key files

| File                                        | What it does                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config/env.ts`                         | Environment schema. Secret at least 32 characters; production refuses placeholder or repetitive secrets and a non-https `WEB_APP_URL`.                 |
| `src/platform/auth/auth.guard.ts`           | The one global guard: development-only 404, public, authenticate (bearer or cookie, database check), CSRF, actor, policy. Order in its header comment. |
| `src/platform/auth/auth.service.ts`         | Login (slug rule, lockout, generic failure), refresh, logout, sessions, set-password, change-password, the security audit events.                      |
| `src/platform/auth/sessions.ts`             | Session creation, refresh rotation with the race and reuse rule, revocation.                                                                           |
| `src/platform/auth/auth-admin.service.ts`   | The contract for business modules: `issueOneTimeCode`, `revokeUserSessions`, `setPasswordForSeed`, `isActivated`, `activatedUserIds`.                  |
| `src/platform/auth/auth-settings.ts`        | Every auth setting and the default rate limits.                                                                                                        |
| `src/platform/authz/policy.decorator.ts`    | `@Policy`, `@Authenticated`, `@DevelopmentOnly`.                                                                                                       |
| `src/platform/http/api-exception.filter.ts` | Standard error body; maps Prisma `P2002` to 409, `P2003` to 422, `P2025` to 404; sets `Retry-After`.                                                   |
| `src/platform/audit/audit.service.ts`       | `record(tx, input)`: one audit row with redacted `before`, `after`, and `changes`.                                                                     |
| `src/operations/access/policies.ts`         | The policy registry: name, roles, description. `listPolicies()`. The permissions matrix is written from it.                                            |
| `src/operations/access/access.service.ts`   | `context()` (per-request cached access context) and `runAsSystem()`.                                                                                   |
| `src/operations/access/visibility.ts`       | `Visibility` values, `isVisible()`, `visibilityWhere()`.                                                                                               |
| `src/operations/access/rules/`              | Pure rules per resource returning a `Decision`; `decision.ts` `enforce()` turns it into 404, 403, or 409.                                              |
| `src/operations/common/change-recorder.ts`  | `record(tx, change)`: the audit event and the outbox event of one change.                                                                              |
| `src/operations/common/references.ts`       | `assertActiveReferences` (exists, same organization, not archived, visible to the caller, else 422) and `assertValidParent`.                           |
| `src/operations/scope/resolve-scope.ts`     | The scope rules (1 to 8, including `colleagueIds`), as a pure function.                                                                                |
| `src/operations/seed/demo-seed.ts`          | The demo data, `DEV_PASSWORDS`, and `seedDemo(app)`.                                                                                                   |
| `test/support/test-app.ts`                  | The integration harness: `as(userId)`, `loginAs`, `bearer`, `browser()`, `clock`, `notifications`, `rateLimiter`.                                      |
| `prisma.config.ts`                          | Prisma 7 config. Attaches `DATABASE_URL` only when set.                                                                                                |
| `eslint.config.mjs`                         | Base config, decorator parser options, and the rule that forbids `src/platform` importing `src/operations`.                                            |
| `nest-cli.json`                             | `deleteOutDir: true`: every `nest build` wipes `dist/`.                                                                                                |

## Environment variables

Values come from the root `.env`, except `NODE_ENV`, which the scripts set.

| Variable                                                        | Rule                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                      | `development`, `test`, or `production`. Optional; defaults to `production`. Set by scripts.    |
| `DATABASE_URL`                                                  | Required. Must start with `postgres://` or `postgresql://`.                                    |
| `DATABASE_CONNECT_TIMEOUT_MS`                                   | Required. Positive integer, milliseconds.                                                      |
| `API_HOST`                                                      | Required. `127.0.0.1` in `.env.example`. `0.0.0.0` only for a phone test on a trusted network. |
| `API_PORT`                                                      | Required. Integer 1 to 65535.                                                                  |
| `CORS_ORIGINS`                                                  | Required. Comma-separated browser origins; also the CSRF Origin allow-list.                    |
| `LOG_LEVEL`                                                     | Required. One of `verbose`, `debug`, `log`, `warn`, `error`, `fatal`.                          |
| `TRUST_PROXY_HOPS`                                              | Optional, 0 to 10, default 0. Number of reverse proxies to trust for the client address.       |
| `AUTH_ACCESS_TOKEN_SECRET`                                      | Required, at least 32 characters. Production refuses placeholder or repetitive values.         |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`                                 | Optional, 30 to 86400, default 900.                                                            |
| `AUTH_REFRESH_TOKEN_TTL_DAYS`, `AUTH_SESSION_ABSOLUTE_TTL_DAYS` | Optional, defaults 30 and 90; the absolute value may not be shorter.                           |
| `AUTH_REFRESH_REUSE_GRACE_SECONDS`                              | Optional, 0 to 60, default 10.                                                                 |
| `AUTH_ACTIVATION_CODE_TTL_HOURS`, `AUTH_RESET_CODE_TTL_MINUTES` | Optional, defaults 72 and 60.                                                                  |
| `AUTH_MAX_FAILED_LOGINS`, `AUTH_LOCKOUT_MINUTES`                | Optional, defaults 5 and 15.                                                                   |
| `AUTH_COOKIE_DOMAIN`                                            | Optional domain name; empty means host-only cookies.                                           |
| `WEB_APP_URL`                                                   | Required http(s) URL; `https://` in production. Base of the activation link.                   |
| `DATABASE_URL_TEST`                                             | Read only by the integration tests. Database name must end in `_test`.                         |

If any is wrong, the process prints one line per variable and exits with code 1, never printing
values. `DEV_AUTH_ENABLED` no longer exists.

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
| `db:reset`         | `prisma migrate reset --force`, then `db:seed`. **Never executed so far. Owner only, never an agent.**           |
| `db:studio`        | `prisma studio` with the root `.env`                                                                             |
| `postinstall`      | `prisma generate`                                                                                                |

## Seed

- `pnpm db:seed` creates the organization "HZ Demo" (slug `hz-demo`) with 2 sites (North Depot,
  Harbour Project), 3 teams (Electrical, Maintenance, Logistics), 10 users with 10 memberships
  (1 admin and 1 manager, organization-wide; 2 supervisors, one scoped to a site and one to a site
  plus a team; 6 workers, one in two teams), 3 log types, 8 tasks, and 25 work logs over 14 days.
- Every user has a username; two workers have a phone number and no email. In `development` and
  `test` every user gets the password of their highest role from `DEV_PASSWORDS` (through
  `AuthAdminService.setPasswordForSeed`, which refuses production). In production no password is
  set and users get activation codes instead. The seed prints names, roles, and identifiers, and
  where the passwords are defined; never a password.
- The structure is created under `AccessService.runAsSystem`; tasks and work logs are created as
  the demo users (creator, author), so they pass the same rules as a request. Work log `createdAt`
  is back-dated with a direct update (seed only) so older logs are outside the edit window and
  today's inside it; some logs are approved or rejected by the manager.
- Idempotent on the slug: if the organization exists, nothing is written.
- The seed compiles the API with `tsc` into `node_modules/.cache/ops-seed` (decorator metadata;
  `dist/` belongs to a running dev server).
- **The development database still holds the Phase 2 seed** (no usernames, no passwords) until the
  owner runs `pnpm db:reset`.

## Tests

- **Unit** (`pnpm --filter @ops/api test`): `src/**/*.spec.ts`, 15 suites, 367 tests. No database,
  no `.env`. Covers the environment schema, health, `ZodPipe`, the platform modules, auth (tokens,
  cookies, CSRF, codes, policy, identifiers, rate limiter), `AuthAdminService`, scope resolution,
  the access rules and visibility, and `route-policies.spec.ts`.
- **Integration** (`pnpm test:integration`): `test/*.int-spec.ts`, 14 suites, 1,208 tests, about
  150 seconds. Suites: `harness`, `auth-and-errors`, `auth-login`, `auth-sessions`, `secrets`,
  `org-structure`, `log-types`, `tasks`, `work-logs`, `audit-outbox-transaction`,
  `audit-outbox-read`, `tenant-isolation`, `permissions-matrix` (535, every cell, fixture in
  `support/matrix-world.ts`), `permissions-cases`.
- The harness authenticates for real: `as(userId)` opens a `mobile` session through
  `SessionService` and sends its bearer token; `loginAs` and `browser()` (cookie jar, Origin,
  CSRF) test the sign-in paths. A fake clock drives token, code, lockout, rate-limit, and edit
  windows; a fake notification sender keeps the codes (`notifications.lastCode(userId)`).
  Factories write rows directly with Prisma.
- **The safety guard** is `resolveTestDatabase` in `test/support/test-database.ts`: it refuses to
  run unless `DATABASE_URL_TEST` is set, its database name ends in `_test`, and differs from the one
  in `DATABASE_URL`. Do not weaken it.
- The suites share one database and truncate it between tests, so they run with one worker.
- `run-integration.mjs` exists because the dotenv-cli shim sets `NODE_PATH` to pnpm's hoisted
  store, where the mobile app's Jest 29 packages live.

## Conventions

- Every route declares `@Public()`, `@Authenticated()`, or `@Policy(...)`; a new policy goes into
  `access/policies.ts`, the matrix in ARCHITECTURE.md, and the matrix suite.
- Controllers handle HTTP only: `ZodPipe` on every input, one service call, no role checks.
- Services start with `const context = await this.access.context()`, load records through the
  resource's `xxxVisibilityWhere(context)`, and `enforce(rule(context, facts, ...))` before
  writing. 404 before 403 before 409.
- Every write follows the pattern in `ChangeRecorder`'s comment, inside `prisma.$transaction`.
  Author fields come from `authorOf(context)`. When access is taken away, call
  `AuthAdminService.revokeUserSessions` in the same transaction.
- Body references are checked with `assertActiveReferences`, passing the caller's visibility.
- A no-op write returns the record and records nothing.
- New entity types go into `EntityType` and `PAYLOAD_KEYS` in `change-recorder.ts`, and into
  `ReferenceKind` in `references.ts` if other records can point at them.
- Platform code writes through narrow structural types (`AuditWriter`, `OutboxWriter`,
  `AuthDatabase`), not the generated Prisma types, and states its host requirements in a header
  comment.
- Read configuration through `ConfigService`. Do not read `process.env` outside
  `src/config/env.ts` and `src/main.ts`. A new variable goes into `envSchema`, `.env.example`, and
  `globalPassThroughEnv` in `turbo.json`.
- The package is CommonJS (no `"type": "module"`). Relative imports have no `.js` extension.
- Classes injected through constructors must be value imports, not `import type`.
- Never log a connection string, a request body, a header, a cookie, a query value, a password, a
  one-time code, or a token.

## Known issues

- **Rate limits are in memory per process**; a restart clears them, several instances count
  separately. Bind a shared store under `RATE_LIMITER` before scaling out.
- **Lockout can be used to keep a known account locked** (accepted, ADR-0004).
- **The client supplies the attachment `storageKey`**; a duplicate answers 409 even when the other
  attachment is invisible. The API must generate it before a provider is bound (Phase 4).
- **One-time codes are only logged, in development.** Production delivers nothing until a real
  `NotificationSender` is bound, and logs a warning per code.
- **Redaction is by key name** in audit and outbox events.
- **The append-only trigger does not block `TRUNCATE`.**
- **No optimistic locking.** Concurrent updates are last-write-wins.
- **Outbox sequences are assigned at insert, not commit.**
- **`db:reset` has no guard on its target database.**
- Scope resolution loads every membership, site, and team of the organization once per request;
  every authenticated request also reads the session and the user.
- Old log type definitions are recoverable only from the audit log.
- Memberships, log types, tasks, work logs, and attachments have no restore endpoint.
- Tenancy and scope are enforced in application code only.
- `/health` logs an error on every call while the database is down, is public, and reveals
  whether the database is up.
- `nest build` deletes `dist/` under a running dev server.
- Code comments in `packages/shared/src/domain/users.ts` (`listUsersQuerySchema`) and
  `access/rules/user.rules.ts` (`contactVisibility`) say a search matches the username for
  contact-visible users; the service matches the username for admins only.
- `users.service.ts` has a leftover duplicate doc comment above `activationStates`.
- The Swagger description in `main.ts` and the `description` in `package.json` still say
  "Operations App".
- NestJS 12 packages are ESM-only while this package is CommonJS (Node 24 `require` of ESM, and
  `--experimental-vm-modules` in the test scripts).
- Prisma is pinned to exactly `7.10.0` (three packages). Upgrade all three together.
- From PowerShell, `pnpm exec dotenv ... -- <cmd>` drops the arguments after `--`. Use the package
  scripts, or call `node_modules\.bin\dotenv.cmd` directly.
