# MEMORY.md

Current state of the HZ project (repository folder `Operations_App`, packages `@ops/*`). Update this
file at the end of every session. Newest session log entry goes first. Last updated: 2026-10-13.

## Current phase

**Phase 2 (Backend core): code complete, pending the owner's manual checks and commit.** Nothing
from Phase 2 is committed; the only commit on `main` is Phase 1 (`d03c843`). **Phase 3
(Authentication & permissions) is next.** Phases are defined in [ROADMAP.md](ROADMAP.md).

**HZ** is the client's product name. Kaneri.ai builds and powers it. "Operations" remains the
technical name of the folder, the packages, the API domain folder, and the database.

## What exists

| Area              | State                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo          | pnpm 12 workspaces + Turborepo 2. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `format`, `format:check`, `db:up`, `db:down`, `db:logs`, `db:migrate`, `db:seed`, `db:reset`.   |
| `packages/config` | Shared ESLint 10 flat config, Prettier config, and three tsconfig presets. Unchanged in Phase 2.                                                                                                                 |
| `packages/shared` | Zod schemas and typed endpoint functions for every API resource, the API transport and client, the health monitor, custom-field validation, and design tokens with tested contrast.                              |
| `apps/api`        | NestJS 12 API: 38 paths, organization and scope model, tasks, work logs, configurable log types, attachment metadata, audit log, event outbox, scope resolution, Swagger in development, a demo seed.            |
| `apps/web`        | Next.js 16.4 placeholder page with the client's branding and an "API status" card that retries on its own.                                                                                                       |
| `apps/mobile`     | Expo SDK 57 placeholder screen with the client's branding and the same status card. Icon and splash are configured in `app.config.ts`.                                                                           |
| Database          | PostgreSQL 17 in Docker Compose, published on `127.0.0.1` only. Two migrations applied to `operations_app`. A second database, `operations_app_test`, is created by the integration tests.                       |
| Docs              | `AGENTS.md`, this file, `ARCHITECTURE.md`, `ROADMAP.md`, `README.md`, ADR-0001 to ADR-0003, a `memory.md` in each app and package, the owner's phase prompt in `docs/prompts/`, the logo files in `docs/brand/`. |
| Subagents         | `reviewer`, `docs-keeper`, `test-writer` in `.claude/agents/`.                                                                                                                                                   |

Not built yet: sign-in, permission enforcement on any route, file upload or storage, any feature
screen in web or mobile, offline storage, notifications, an outbox consumer, and the AI layer. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## TEMPORARY: the dev header

There is no authentication. Until Phase 3 the acting user is taken from the request header
**`x-dev-user-id`** (a user id). Anyone who can reach the API with this enabled can act as any
user, and no route checks role or scope.

- Honoured only when `NODE_ENV=development` **and** `DEV_AUTH_ENABLED=true`.
- `NODE_ENV` is set by the package scripts (`dev` sets `development`, `start` sets `production`),
  not by `.env`. Unset means `production`.
- The API refuses to boot with `DEV_AUTH_ENABLED=true` in any other `NODE_ENV`. The guard
  re-checks on its own; with dev auth off, every route except `/health` answers 401.
- `.env.example` sets `DEV_AUTH_ENABLED=true` and `API_HOST=127.0.0.1`. Keep the API on loopback
  while the flag is on.
- Remove in Phase 3: `apps/api/src/platform/dev-auth/`, `DEV_AUTH_ENABLED`, `DEV_USER_HEADER` in
  `@ops/shared`, and the `devUserHeader` option of the Swagger setup.

## Verified

**By the owner, manually, on 2026-10-13 (Phase 1 leftovers)**

- `pnpm db:up` reports the PostgreSQL container healthy.
- `GET http://localhost:3001/health` returns 200 with `"database":"up"`.
- The first commit is on `main` (`d03c843`, Phase 1).

**In the Phase 2 session on 2026-10-13**

- Root `pnpm install` (no changes), `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:integration`, `pnpm build`, and `pnpm format:check` all pass.
- Unit tests: 500 in `@ops/api` (7 suites), 432 in `@ops/shared` (9 files), 6 in `@ops/web`, 8 in
  `@ops/mobile`. The docs-keeper re-ran `pnpm test` and confirmed these counts.
- Integration tests: 532 tests in 9 suites, about 45 seconds, against `operations_app_test` only.
- Both migrations are applied to the development database.
- `pnpm db:seed` ran once: 81 audit rows and 81 outbox rows, all with the `system` actor.
- The API boots in development, serves the seeded data with the dev header, and `/docs` lists 38
  paths.
- The API refuses to boot with `DEV_AUTH_ENABLED=true` when `NODE_ENV` is `production`, `test`, or
  unset.
- The production build of the web app has the title "HZ · Manager dashboard".
- Mobile: `expo export` succeeds for Android and iOS; `expo-doctor` passes 21/21.

## Not yet verified

1. **`pnpm db:reset` has never been executed**, by anyone. A person must run it: Prisma refuses
   `migrate reset` when it detects an AI agent environment.
2. The full `pnpm dev` (API, web, Metro together) with the HZ branding in a real browser after a
   restart. Pending.
3. The web "API status" card recovering in a real browser when the API comes up after the page
   (retries after 2, 4, 8, 16 seconds, then "Check again"). Unit tested only.
4. Anything on a phone: Expo Go reaching the API, and the icon and splash screen in a real build.
   **Deferred to Phase 4**; the campus Wi-Fi blocks phone-to-PC traffic.
5. The owner's manual checks of the API (README section 4) and the Phase 2 commit. The docs-keeper
   ran the read-only requests of that section against a temporary development instance (users,
   scope, audit events, outbox events, `/docs-json` with 38 paths) and validated the example work
   log body against `createWorkLogSchema`; the `POST` itself was not sent.
6. **The `pnpm dev` that was running at the end of the 2026-10-13 session is stale.** It was started before
   the Phase 2 environment changes, so its API process listens on `0.0.0.0`, answers 401 on every
   route, and serves no `/docs`. Stop it and start `pnpm dev` again before any manual check.

## Machine and repository state

- Node 24.20.0, pnpm 12.11.2, Git 2.55, Docker Desktop with the WSL 2 backend. Windows long paths
  enabled.
- Docker and PostgreSQL run. Docker Desktop stopped on its own once on 2026-10-13 (cause
  unknown); `docker desktop restart` brought it back.
- Branch `main`, one commit (`d03c843`). All Phase 2 work is uncommitted in the working tree. A git
  identity is configured.
- A local `.env` exists (git-ignored) with the same keys as `.env.example`.
- **Development database contents**: the demo seed plus leftovers from manual checks (two archived
  sites, an archived "Check User" with an archived membership, one attachment, the Inspection log
  type at version 3, 27 work logs instead of 25). `pnpm db:reset` gives a clean state.
- User ids are generated, so they change on every reset. `pnpm db:seed` prints them when it seeds;
  afterwards read them from `GET /users` (which itself needs one id) or Prisma Studio.

## Known limitations

Security and data (all acceptable only because the API is local and has no real data)

- No authentication and no permission enforcement (see "TEMPORARY: the dev header").
- Request bodies trust the caller: any user can set `authorId` to someone else, create a work log
  as `approved`, edit an approved log, set any status from any status, and receive the stored log
  of any user in the organization by retrying its `clientId`.
- `GET /audit-events` and `GET /outbox-events` are readable by every user of the organization and
  hold full entity snapshots (email, phone, free text, GPS positions).
- The audit log is append-only, so personal data in it cannot be erased.
- The append-only trigger blocks `UPDATE` and `DELETE` but not `TRUNCATE`. A database role allowed
  to truncate can empty the audit log. The integration test harness relies on this.
- Tenancy is enforced in application code only (no composite foreign keys, no row-level security).
- The client supplies the attachment `storageKey`. The API must generate it before a storage
  provider exists.
- `pnpm db:reset` has no guard on its target: it resets whatever `DATABASE_URL` points at.

Behaviour

- Redaction in audit and outbox events is by key name at any depth. A custom field keyed
  `token_no` or `batch_hash` is stored as `"[redacted]"` there, while the work log keeps the value.
- Old log type definitions are not kept. A work log's `logTypeVersion` can be resolved to its
  definition only through the audit log.
- No optimistic locking or row version. Concurrent updates are last-write-wins and can record a
  stale `before` in the audit log.
- Outbox sequence numbers are assigned at insert, not at commit. A consumer that uses the cursor
  alone can miss an event from a late-committing transaction.
- Scope resolution reads every membership, site, and team of the organization on each call.
- Only users, sites, and teams can be restored. Memberships, log types, tasks, work logs, and
  attachments can be archived but not restored.
- Seeded tasks all have `createdAt` at seed time; only `dueAt` is spread over time.
- `/health` logs an error on every call while the database is down.

Clients and tooling

- Web and mobile still show only a placeholder with a status card. They call `GET /health` and
  nothing else, and neither sends the dev header.
- `API_HOST=127.0.0.1` means a phone cannot reach the API. A phone test needs `API_HOST=0.0.0.0`
  on a trusted network, and `EXPO_PUBLIC_API_URL` set to the PC's Wi-Fi address.
- Expo Go shows its own icon and splash screen; the configured ones appear only in a development
  or release build. There is still no mobile `build` script.
- The mobile bundle identifiers (`ai.kaneri.operations`) are hard-coded in `app.config.ts`.
- `expo start --tunnel` is not available; it needs `@expo/ngrok`, which is not installed.
- `.env` is a global Turbo dependency, so editing any value invalidates every cached task.
- Root `pnpm dev` runs Expo under Turbo, where the QR code may not appear. Run
  `pnpm --filter @ops/mobile dev` in its own terminal to get it.
- `nest build` deletes `apps/api/dist`, which breaks a running `pnpm dev` API until it recompiles.
- Integration tests are not part of `pnpm test` and there is no CI pipeline.
- Product-name leftovers that are code or configuration, not documentation: the `description`
  fields in the `package.json` files and the Swagger description in `apps/api/src/main.ts` still
  say "Operations App".

## Open questions

Phase 3 (before any route is wired)

- Which authentication mechanism (in-house credentials and sessions, or an external identity
  provider)? Needs an ADR.
- The record-visibility rule: how do `siteIds`, `teamIds`, `userIds`, and `memberOf` combine for
  one record? For example, a worker with no site or team whose work log carries a supervisor's
  site.
- Per-field permissions for request bodies, and status transition rules for work logs and tasks.
- Who may read audit and outbox events?
- Where is the resolved scope cached (per request, per user)?

Later phases

- Phase 4: which object storage provider for photos, and what are the size and retention limits?
  What are the final mobile bundle identifiers, and where do they come from?
- Phase 5: which local database, and what is the conflict rule? Does the server need a row
  version?
- Phase 6: who manages log types and their custom fields? Today it is possible only through the
  API; no admin screen is planned in the roadmap criteria.
- Phase 6 or later: which push notification provider, and are notifications needed earlier?
- Phase 7: which AI provider and hosting constraints (data residency, cost limits)? How does the
  outbox consumer avoid missing late-committing events?
- Before Phase 8: retention and erasure of personal data in the append-only audit log and the
  outbox.
- Before a second client: does tenancy need database-level enforcement?
- Why did Docker Desktop stop on its own on 2026-10-13?

Answered in Phase 2 (see [ADR-0002](docs/decisions/0002-flexible-organization-and-scope-model.md)):
scope is by site and by team, both optional, and a user can hold several memberships; the model is
multi-tenant-ready with one organization per user.

## Session log

### 2026-10-13: Phase 2 backend core, audit, outbox, and HZ branding

- **What changed**
  - Database: the Prisma schema with 14 models and two migrations (`20261013112952_init`,
    including the append-only trigger on `AuditEvent`, and
    `20261013150000_attachment_storage_key_per_org`). UUIDv7 ids, PostgreSQL enums.
  - API: split into `src/platform` (request context, HTTP conventions, audit, outbox, temporary
    dev auth, Swagger) and `src/operations` (organization, users, memberships, sites, teams, log
    types, tasks, work logs, attachments, scope, storage interface, seed). 38 paths. ESLint forbids
    platform importing operations.
  - Every write is one transaction: business row, audit event, outbox event, through
    `ChangeRecorder`.
  - `@ops/shared`: schemas and endpoint functions per resource, the typed API client, the health
    monitor, custom-field validation, design tokens.
  - Web and mobile: HZ branding from configuration, tokens from `@ops/shared`, the unified health
    client. Mobile `app.json` was replaced by `app.config.ts`. The per-app health clients and
    their tests were deleted.
  - Seed: `pnpm db:seed` (demo organization "HZ Demo", slug `hz-demo`, idempotent) and
    `pnpm db:reset`.
  - Tests: unit tests grew from 16 to 946; a new integration suite of 532 tests.
  - Configuration: `.env.example` gained `DEV_AUTH_ENABLED`, `DATABASE_URL_TEST`,
    `NEXT_PUBLIC_BRAND_NAME`, `EXPO_PUBLIC_BRAND_NAME`, and `API_HOST` changed from `0.0.0.0` to
    `127.0.0.1`. `turbo.json` passes the new variables through. `pnpm-workspace.yaml` decides two
    more build scripts (`@scarf/scarf` denied, `esbuild` allowed). New dependencies:
    `@nestjs/swagger` and `tsx` (API), `expo-splash-screen` and `expo-system-ui` (mobile).
    `.prettierignore` gained `apps/api/prisma/migrations` and `docs/prompts`.
  - Docs: every document rewritten for Phase 2; ADR-0002 and ADR-0003 added.
- **Why**: Phase 2 of the roadmap, as specified in `docs/prompts/phase-2.md`. The client's
  structure is not known yet, so the organization model and the log types had to be flexible, and
  audit and events had to exist before any feature writes data.
- **How it was built**: three parallel subagents (domain API, platform modules, branding), then
  the `test-writer`, then an independent `reviewer`, then the `docs-keeper`.
  - The test-writer found two bugs and several doubtful rules. Fixed: search terms were not
    escaped for `LIKE`; an out-of-range outbox cursor caused a 500 and is now a 400; outbox
    payloads were not redacted; workers assigned to an ancestor site or team were not visible to
    the supervisor of a descendant; the attachment storage key was unique globally instead of per
    organization; request bodies accepted unknown keys; the upper bound of date ranges was
    inclusive in places.
  - The reviewer returned "pass with fixes", no blockers. Fixed: `API_HOST` defaulted to all
    interfaces (`0.0.0.0`) while dev auth was on; the `x-powered-by` header was sent; the
    message the seed prints when the organization already exists was reworded.
- **Verified**: see "Verified" above.
- **Left to do**
  - Owner: restart `pnpm dev`, run the manual checks in README section 4, run `pnpm db:reset`
    once, look at the branding in a browser, then review and commit.
  - Phase 3 must first answer the open questions above, in an ADR.

### 2026-10-12: Phase 1 setup and documentation

- **What changed**: machine prepared (Node, pnpm, Git, WSL 2, Docker Desktop, long paths). Monorepo
  scaffolded: root tooling, `packages/config`, `packages/shared`, `apps/api`, `apps/web`,
  `apps/mobile`, Docker Compose for PostgreSQL, `.env.example`, and three project subagents. The
  documentation system was then written from the code: `AGENTS.md`, `MEMORY.md`, `ARCHITECTURE.md`,
  `ROADMAP.md`, `README.md`, `docs/decisions/` with ADR-0001, and five folder `memory.md` files.
- **Why**: Phase 1 of the roadmap. Establish a working, documented base before any feature work.
- **Verified** on 2026-10-12: root `pnpm install`, `build`, `lint`, `typecheck`, `test`, and
  `format:check`; root `pnpm dev`; 16 unit tests; `GET /health` returning 503 with the database
  down; the web dev server on port 3000; Metro, `expo export`, and `expo-doctor` 21/21.
- **Review**: an independent reviewer pass returned "pass with fixes", no blockers. Fixed in the
  same session and re-verified with the root checks:
  - The web app no longer throws when `NEXT_PUBLIC_API_URL` is missing; `env.apiUrl` is `null` and
    the status card shows "API not configured" (same behaviour as mobile). `pnpm build` now passes
    without a `.env`.
  - `turbo.json` lists the app variables in `globalPassThroughEnv`, so variables set in the shell
    or CI reach the tasks, not only those from `.env`.
  - PostgreSQL is published on `127.0.0.1` only (it was on all interfaces).
  - `packages/config/tsconfig/strict.json` holds the strictness flags; `base.json` and the mobile
    tsconfig both extend it, so mobile no longer copies them.
  - API scripts run `prisma generate --no-hints` to hide the "update to Prisma 8" banner.
- **Left at the time**: reboot the machine and run five manual checks. Three were done by the
  owner on 2026-10-13 (PostgreSQL starts, `/health` 200, first commit); `db:migrate` ran in the
  Phase 2 session; the browser check is still pending and the phone check moved to Phase 4.
