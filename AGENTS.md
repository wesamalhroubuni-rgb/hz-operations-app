# AGENTS.md

Rules for AI agents working on the HZ monorepo (folder `Operations_App`, packages `@ops/*`).
`CLAUDE.md` imports this file, so it is loaded into every session. Keep it short and true.

## Working directory

Always state and work in `D:\Personal Projects\Huseyin\Operations_App` (Windows 11, PowerShell).
Run every command from this root unless a step says otherwise.

## Read order at the start of every session

1. `AGENTS.md` (this file)
2. [MEMORY.md](MEMORY.md): current state, what works, what is unverified, session log
3. [ARCHITECTURE.md](ARCHITECTURE.md): structure, layering, what exists versus what is planned
4. [ROADMAP.md](ROADMAP.md): the 8 phases and their "done when" criteria
5. The `memory.md` of every folder you will touch (`apps/api`, `apps/web`, `apps/mobile`,
   `packages/shared`, `packages/config`)

Decisions are recorded in [docs/decisions/](docs/decisions/README.md). Human setup steps are in
[README.md](README.md).

## What this project is

**HZ** is the client's product; Kaneri.ai builds and powers it. Workers log their work from their
phones (text, photos, location, later voice). Supervisors and managers monitor it on a web
dashboard. A later AI layer summarises, flags anomalies, and proposes actions that a human
approves. Roles: worker, supervisor, manager, admin. Users see only the data their role and scope
(sites and teams, through memberships) allow, and the AI layer is bound by the same rule.

Naming: never hard-code a client name. The name shown in the apps comes from
`NEXT_PUBLIC_BRAND_NAME` / `EXPO_PUBLIC_BRAND_NAME` through each app's brand module. "Operations"
stays as the technical name (folder, `@ops/*`, `src/operations`, database `operations_app`).

State on 2026-10-28: Phases 1 to 4 are committed (Phase 4: `280c50a`). Phase 5 (offline mode and
sync, ADR-0008) is code complete, tested, and reviewed: the API (57 paths) adds row versions,
typed conflict codes, `Idempotency-Key` handling, offline audit metadata, and `GET /sync/pull`;
the mobile app keeps a per-user SQLite cache and write queue and syncs when the connection
returns. **Nothing has run on a phone or in the emulator yet** (README section 6). The owner must
run `pnpm db:reset` once (the development database holds a stray migration from lost work). The
web app still has only login, activation, and a placeholder home. Phase 6 (web dashboard) is
next. See [MEMORY.md](MEMORY.md).

## Engineering principles

- Make small, testable changes.
- Understand the existing code before modifying it.
- No unnecessary rewrites. Preserve working functionality.
- Keep business logic separate from UI, integrations, and presentation.
- No hard-coded credentials, environment values, or provider-specific logic where configuration or
  an abstraction fits. Configuration comes from environment variables documented in `.env.example`.
- Automated actions need clear error handling, logging, and traceability.
- Add or update tests when behaviour changes.
- Recommend one option. Do not list unranked alternatives.
- Reusable platform components (request context, HTTP conventions, audit log, outbox, auth,
  permissions, notifications, AI layer, configuration) live in self-contained modules with no
  Operations-specific imports, so they can be extracted into shared Kaneri packages later. In the
  API that is `src/platform`; `src/operations` may import it, never the reverse (ESLint enforces
  it). See [ARCHITECTURE.md](ARCHITECTURE.md).

## Before a substantial feature, state

1. Business objective
2. Expected behaviour
3. Components affected
4. Data required
5. External integrations
6. Failure cases
7. Test plan

## After a substantial change, report

1. What changed
2. Why
3. Files modified
4. Architectural decisions (write an ADR in `docs/decisions/` for significant ones)
5. Tests performed
6. Limitations and next steps

## End of every session

Update [MEMORY.md](MEMORY.md) (state plus a dated session log entry, newest first) and the
`memory.md` of every folder touched. Use absolute dates (YYYY-MM-DD). Document what is in the repo,
not what was intended.

## Project subagents (`.claude/agents/`)

| Agent         | What it does                                                                                                                                                                                  | When to use it                                                                                           | Edits files?                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `reviewer`    | Independent review against `AGENTS.md`, the phase prompt, and the `ROADMAP.md` criteria. Runs install, lint, typecheck, test, build, and format check, starts the affected apps, and reports. | At the end of every phase and before reporting a substantial change as done.                             | No. Read-only; it reports findings and does not fix.   |
| `docs-keeper` | Brings `MEMORY.md`, `ARCHITECTURE.md`, `ROADMAP.md`, ADRs, `README.md`, and folder `memory.md` files in line with the code. The repo wins over the session summary.                           | At the end of every session and after any architectural decision.                                        | Docs only. Never source, config, or tests.             |
| `test-writer` | Writes and runs tests for new or changed behaviour, including failure cases and both the allowed and denied case for permission rules.                                                        | Whenever behaviour is added or changed, and when fixing a bug (write the test that reproduces it first). | Tests; production code only minimally for testability. |

## Commands

All from the repo root. Package names: `@ops/api`, `@ops/web`, `@ops/mobile`, `@ops/shared`,
`@ops/config`.

| Task                              | Command                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Install                           | `pnpm install`                                                                                        |
| Start / stop PostgreSQL and MinIO | `pnpm db:up` / `pnpm db:down` (logs: `pnpm db:logs`, PostgreSQL only; `docker compose logs -f minio`) |
| Run everything                    | `pnpm dev`                                                                                            |
| Run one app                       | `pnpm --filter @ops/api dev` (same for `@ops/web`, `@ops/mobile`)                                     |
| Mobile development build          | `pnpm --filter @ops/mobile dev:client` (Expo Go: `dev`, which runs `expo start --go`)                 |
| Checks                            | `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`                                              |
| Integration tests                 | `pnpm test:integration` (needs PostgreSQL, MinIO, and `DATABASE_URL_TEST`; not in `pnpm test`)        |
| Formatting                        | `pnpm format` (writes), `pnpm format:check`                                                           |
| Migrations                        | `pnpm db:migrate` (`prisma migrate dev`); `pnpm --filter @ops/api db:deploy`                          |
| Demo data                         | `pnpm db:seed` (idempotent). `pnpm db:reset` wipes the dev database: **owner only**                   |
| Other Prisma                      | `pnpm --filter @ops/api db:generate`, `db:studio`                                                     |

Ports: API 3001 on `127.0.0.1` (`/health`; in development also `/docs`, `/docs-json`,
`/docs-yaml`), web 3000, Metro 8081, PostgreSQL 5432 (5433 on the owner's PC through the local
`.env`, because another project's PostgreSQL holds 5432), MinIO 9000 (S3 API) and 9001 (console).

Calling the API in development: `POST /auth/login` with `"client": "mobile"` and send
`Authorization: Bearer <tokens.accessToken>`. Identifiers per seeded role and PowerShell examples
are in [README.md](README.md) section 4. The seed's development passwords are in `DEV_PASSWORDS` in
`apps/api/src/operations/seed/demo-seed.ts`; never print or copy them.

If `node`, `pnpm`, or `git` are not found in an agent shell, prefix the command with:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;C:\Program Files\Git\cmd;$env:Path";
```

## Gotchas

**Environment**

- There is one `.env`, at the repo root, for every app and for Docker Compose. App scripts load it
  with `dotenv -e ../../.env --` (dotenv-cli). Do not add per-app `.env` files.
- A new variable must be added to `.env.example`, to the consuming app's validation
  (`apps/api/src/config/env.ts`, `apps/web/src/lib/env.ts`, `apps/mobile/src/config/env.ts`), and
  to `globalPassThroughEnv` in `turbo.json`. Turbo runs tasks in strict env mode and strips any
  shell or CI variable that is not listed there.
- PostgreSQL is published on `127.0.0.1` only, and so is the MinIO console. Do not widen those
  port mappings in `docker-compose.yml`. A phone needs the API (3001), Metro (8081), and the MinIO
  S3 port (9000, through `MINIO_BIND_HOST`, `127.0.0.1` by default; `0.0.0.0` only for a phone
  test). The `MINIO_*` variables are read by Docker Compose only (not in `turbo.json`).
- The API validates its environment with Zod at boot and exits with one line per bad variable.
  Required: `DATABASE_URL`, `DATABASE_CONNECT_TIMEOUT_MS`, `API_HOST`, `API_PORT`, `CORS_ORIGINS`,
  `LOG_LEVEL`, `AUTH_ACCESS_TOKEN_SECRET` (at least 32 characters), `WEB_APP_URL`,
  `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`,
  `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`. Optional with defaults: `NODE_ENV`
  (`production`), `TRUST_PROXY_HOPS` (0), the `AUTH_*` durations and limits,
  `STORAGE_FORCE_PATH_STYLE` (true), `UPLOAD_MAX_BYTES` (10 MiB, at most 25 MiB),
  `UPLOAD_URL_TTL_SECONDS` and `DOWNLOAD_URL_TTL_SECONDS` (300), `EXPO_ACCESS_TOKEN` (none),
  `PUSH_ENABLED` and `OUTBOX_CONSUMER_ENABLED` (true), `OUTBOX_POLL_INTERVAL_MS` (2000).
  **Production refuses** a placeholder-looking or repetitive auth secret or storage secret key and
  a non-https `WEB_APP_URL` or `STORAGE_PUBLIC_ENDPOINT`, so `pnpm --filter @ops/api start` fails
  with the `.env.example` values.
- `STORAGE_ENDPOINT` is where the API reaches the storage; `STORAGE_PUBLIC_ENDPOINT` is the host
  written into signed URLs and must be reachable by the phone or browser. A running API keeps
  signing with the value it started with: restart it after changing it.
- `NODE_ENV` is not in `.env`. The API package scripts set it with `dotenv -v`: `dev` and
  `db:seed` use `development`, `start` uses `production`. Unset means production.
- A running process keeps the environment it started with. After changing `.env`, restart
  `pnpm dev`; `NEXT_PUBLIC_*` and `EXPO_PUBLIC_*` values are also inlined at bundle time
  (`expo export` needs `--clear`).

**Auth and permissions** (ADR-0004, ADR-0005, matrix in ARCHITECTURE.md)

- `AuthGuard` (`src/platform/auth/`) is the one global guard and the only way to get an acting
  user. Every route must declare `@Public()`, `@Authenticated()`, or `@Policy('<resource>.<action>')`;
  `src/route-policies.spec.ts` fails otherwise, and the guard refuses the route at runtime. A new
  policy name goes into `apps/api/src/operations/access/policies.ts`, the matrix in
  ARCHITECTURE.md, and the matrix suite.
- Services get the caller through `AccessService.context()` and apply the rule functions in
  `operations/access/rules/` and the `xxxVisibilityWhere` filters. Never write ad-hoc role checks,
  never take `organizationId` as an argument from a controller, and never use `requireActor()` in
  a domain service.
- 404 for a record outside the caller's visibility (same as missing), 403 for a visible record the
  caller may not change or a route the role may not use, 409 for a state conflict, 422 for a bad or
  invisible reference in a body.
- Author fields (`authorId`, `createdById`, `uploadedById`) come from the context, never from a
  body. Business modules touch credentials, codes, and sessions only through `AuthAdminService`,
  inside their own transaction.
- **Never print, log, or write into a document a password, one-time code, or token**, including
  the seed's `DEV_PASSWORDS` and codes from the development log.
- Login without `organizationSlug` works only while exactly one active organization exists. The
  clients send `NEXT_PUBLIC_ORGANIZATION_SLUG` / `EXPO_PUBLIC_ORGANIZATION_SLUG` (`hz-demo`).
- Cookie-authenticated writes need an allowed `Origin` and `x-csrf-token`; scripts should sign in
  as `mobile` and use the bearer token. A 403 on web sign-in usually means the page's origin is
  not in `CORS_ORIGINS`.
- Rate limits are in memory per process: restarting the API clears them. Five failed sign-ins lock
  an account for 15 minutes; an admin password reset lifts it.
- Tests: `ctx.as(userId)` opens a real `mobile` session; `loginAs`, `bearer`, and `browser()` test
  the sign-in paths. Factories write rows directly with Prisma. Code without a request (the seed)
  runs under `AccessService.runAsSystem(organizationId, ...)`, which throws inside a request.
- Keep `API_HOST=127.0.0.1`; `0.0.0.0` is for a phone test on a trusted network only (the demo
  passwords are well known). Swagger is served in development only.

**API rules**

- Every write is one `prisma.$transaction` that writes the business row and then calls
  `ChangeRecorder.record(tx, ...)`, which writes the audit event and the outbox event. Never
  write a business row outside that pattern, and never call `AuditService` or `OutboxService`
  from a domain service directly.
- `src/platform/**` must not import `src/operations/**` (ESLint error).
- The organization always comes from the caller (`AccessService.context()`), never from the URL
  or body. Check ids in a body with `assertActiveReferences`, passing the caller's visibility.
- Request and response schemas live in `@ops/shared`. Request bodies are `z.strictObject`: an
  unknown key is a 400. Validate with `ZodPipe`; document with `ApiDocs`.
- Status conventions: 404 for a missing or other-organization record, 409 for changing an archived
  record or a duplicate unique value, 422 for a bad reference in a body. Date ranges are
  inclusive lower bound, exclusive upper bound. Prefer the typed codes of ADR-0008
  (`ApiException.of('record_archived', ...)`, `version_conflict`, `already_reviewed`, ...): the
  phone maps each code to a message, and each code has one status in `API_ERROR_STATUS`.
- **Offline sync (ADR-0008)**: every change of a `Task` or `WorkLog` row must raise its `version`
  (`NEXT_VERSION`) in the same transaction; check `expectedVersion` with `assertExpectedVersion`
  after the no-op check (a no-op answers 200 even with a stale version). Writes the phone queues
  are `@Idempotent()` and must stay no-ops on a repeat. A `POST /work-logs` with the caller's own
  `clientId` answers 200 before any other check. `src/platform/idempotency/` knows no route names.
- Audit and outbox redact by key name at any depth (`password`, `secret`, `token`, `hash` suffix,
  ...). A field or custom-field key that matches is stored as `"[redacted]"` in both.
- The enum arrays in `packages/shared/src/domain/enums.ts`, `ATTACHMENT_STATUSES`
  (`domain/attachments.ts`), and `PUSH_PLATFORMS` (`platform/notifications.ts`) must match the
  Prisma enums, in order.

**Uploads and storage** (ADR-0006)

- Never accept a storage key from a client. Keys come from `attachmentStorageKey` and
  `verifiedKeyOf` in `operations/attachments/attachments.service.ts`; no key or URL ever goes into
  a response field other than the signed URLs, or into audit or outbox payloads.
- `complete` must keep re-encoding the upload to the API-only `.verified.` key and serving that,
  never the uploaded object (it closes the overwrite window of a still-valid upload URL and strips
  EXIF). Signed URLs are produced only by `AttachmentsService.present`, for ready, non-archived
  rows loaded through `attachmentVisibilityWhere`.
- A `pending` attachment is visible only to its uploader. Upload steps use the archive rule of the
  log (`canChangeAttachments`).
- Development and test create the bucket at start-up and boot without storage (upload routes 503);
  production needs the bucket to exist. Integration tests bind an in-memory `FileStorage`
  (`test/support/fake-file-storage.ts`); only `storage-minio` uses the real MinIO, with the bucket
  `hz-attachments-test`.

**Notifications and the outbox consumer** (ADR-0007)

- Register outbox handlers from Operations modules (`OutboxConsumer.registerHandler`); the
  platform knows no event names. Handlers must be idempotent (create notifications with the
  event's id as `sourceEventId`) and must re-check the record's current state.
- Only `NotificationService` writes `Notification` rows; channels run after the commit. Push text
  must stay generic (no task title, no rejection note): put the full text in the in-app row only.
- Push tokens are bound to the session; session ends remove them through
  `SessionService.onSessionsEnded`. Never log a push token (mask with `maskPushToken`).
- The consumer runs when `OUTBOX_CONSUMER_ENABLED=true` (every `OUTBOX_POLL_INTERVAL_MS`). Tests
  run with it and `PUSH_ENABLED` off (the test configuration omits them) and call
  `processPending()`; an agent-started API with the root `.env` has both on.

**Database safety**

- **Never run `pnpm db:reset` (or `prisma migrate reset`) as an agent.** It wipes whatever
  `DATABASE_URL` points at and has no guard. Prisma refuses it in an agent environment and the
  agent permission system blocks it. Ask the owner.
- Integration tests use `DATABASE_URL_TEST` only and truncate every table. Their guard refuses a
  database whose name does not end in `_test` or equals the one in `DATABASE_URL`. Do not weaken
  it.
- `AuditEvent` is append-only (a trigger blocks `UPDATE` and `DELETE`). Do not write code or
  migrations that change or remove audit rows.
- `docker compose down -v` also deletes the `minio_data` volume (every photo). Do not run it.

**Build order**

- `@ops/shared` compiles to CommonJS in `packages/shared/dist` and must be built before anything
  that depends on it can typecheck, lint, test, or build. Turbo's `^build` dependency does this, so
  use the root scripts. If you run a tool directly inside an app, build `@ops/shared` first.
- `prisma generate` runs on API `postinstall` and before API `dev`, `build`, `typecheck`, `test`,
  `test:integration`, and `db:seed`. The client is generated into `apps/api/src/generated/`
  (git-ignored). Never edit it.
- `nest build` (and so `pnpm build`) deletes `apps/api/dist`, which a running `pnpm dev` API is
  executing. Do not build while the owner's dev server is running, or tell them to restart it.
- `pnpm db:seed` compiles the API into `apps/api/node_modules/.cache/ops-seed` (not `dist`) and
  runs the real services there, so it does not disturb a running dev server.

**pnpm 12**

- Supply-chain policy: pnpm appends `minimumReleaseAgeExclude` entries to `pnpm-workspace.yaml` for
  very recently published packages. Review those entries whenever you add or update a dependency.
- Dependency build scripts are blocked until decided under `allowBuilds` in `pnpm-workspace.yaml`.
  `pnpm install` exits 1 while any is undecided. Current decisions: `prisma`, `@prisma/engines`,
  and `esbuild` allowed; `@parcel/watcher`, `unrs-resolver`, and `@scarf/scarf` denied.
- `pnpm run` and `pnpm exec` perform an implicit install when a manifest has changed.
- `pnpm add` and `pnpm install` can hang in an agent shell that attaches stdin (a prompt nobody
  answers). Give them an empty stdin, for example `cmd /c "pnpm --filter <pkg> add <dep> < NUL"`.
- Expo packages must be the SDK 57 versions: check with `npx expo install --check` from
  `apps/mobile`.
- From PowerShell, `pnpm exec dotenv ... -- <cmd>` loses the arguments after `--`. For ad-hoc
  commands call `node_modules\.bin\dotenv.cmd` directly. Package scripts are not affected.
- The dotenv-cli shim sets `NODE_PATH` to pnpm's hoisted store, where the mobile app's Jest 29
  packages live. Jest 30 started under it loads the wrong runner and fails on the ESM-only Nest
  packages. That is why `test:integration` goes through `apps/api/test/run-integration.mjs`, which
  starts Jest in a child process without `NODE_PATH`. Do not call Jest through dotenv directly.

**Version pins (do not bump casually; see [ADR-0001](docs/decisions/0001-tech-stack.md))**

| Pin                                                                                                                       | Why                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| TypeScript `~6.0.3` everywhere                                                                                            | npm `latest` is 7.0; typescript-eslint 8 supports `<6.1`; Nest CLI and Expo templates are on 6.0. |
| Prisma exactly `7.10.0` (three packages)                                                                                  | The npm `latest` tag points to an 8.0 release candidate.                                          |
| React exactly `19.2.3` in web and mobile                                                                                  | The version Expo SDK 57 pins. One React version across the repo.                                  |
| Expo SDK 57 / React Native `0.86.3`                                                                                       | Must match each other and Expo Go. Upgrade them together.                                         |
| NestJS 12 with a CommonJS API                                                                                             | Nest 12 packages are ESM-only; Node 24 loads them via `require`. Do not add `"type": "module"`.   |
| Jest 30 (api), Jest 29 + jest-expo (mobile)                                                                               | The API test script needs `node --experimental-vm-modules`. jest-expo 57 is built for Jest 29.    |
| Every `expo-*` package `~57.0.x` (`expo` ~57.0.31)                                                                        | Expo SDK 57 packages. They move with the SDK, not on their own.                                   |
| Mobile: React Navigation 7, TanStack Query 5, AsyncStorage, datetimepicker, `@expo/vector-icons`, `zod` at exact versions | Versions Expo SDK 57 accepts (`expo install`); `zod` equal to the one `@ops/shared` uses.         |
| `sharp` `^0.35.5` (API)                                                                                                   | Prebuilt native binary, no install script, so no `allowBuilds` entry. Check that on any bump.     |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` `^3.1152.0`                                                         | Keep both on the same version.                                                                    |
| MinIO image `alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:...`                                                        | Community build (official images are no longer published), pinned by digest. Development only.    |

**Per app**

- API: `/health` logs an error on every call while the database is down. Do not poll it tightly.
  Unit tests are `src/**/*.spec.ts` (no database); integration tests are `test/*.int-spec.ts`.
  The package is CommonJS; relative imports have no `.js` extension.
- Shared: relative imports must end in `.js`. The DOM lib is enabled only for the types of
  `fetch`, `AbortController`, and timers; use no other DOM, Node, or React Native API there.
- Web: `scripts/next.mjs` maps `WEB_PORT` to `PORT`. `agentRules: false` in `next.config.ts` stops
  Next.js generating its own `AGENTS.md` in `apps/web`. `typecheck` runs `next typegen` first.
  Stylesheets use only the CSS variables generated from the tokens in `@ops/shared`. The favicon
  is `src/app/icon.png` (picked up by file name). The session lives in httpOnly cookies the page
  cannot read; only the CSRF token is kept, in memory. The route guard in `auth-provider.tsx` is
  UX only. Security headers are in `next.config.ts` (no `script-src` CSP yet: needs nonces).
- Mobile: no `metro.config.js` or `babel.config.js` (Expo defaults handle the pnpm layout). ESLint
  sets `settings.react.version` to `'19.2'` by hand; bump it when React changes. No `build` script
  by design. Expo config is `app.config.ts` (there is no `app.json`); it repeats the brand-name
  fallback from `src/config/env.ts` because it cannot import it. Expo Go shows its own icon and
  splash. A phone cannot reach `localhost`: a phone test needs `API_HOST=0.0.0.0`,
  `MINIO_BIND_HOST=0.0.0.0`, and the PC's address in `EXPO_PUBLIC_API_URL` and
  `STORAGE_PUBLIC_ENDPOINT` (README section 5). No phone test has been done yet.
- Mobile rules: **every write goes through `src/data/repositories.ts` → the user's write queue**
  (`src/offline/writeQueue.ts`); the sync engine sends it. Screens never call `apiClient`, the
  queue, or the engine to change data; reads come from the local store through
  `src/data/queries.ts`. **One SQLite database per user** (`ops-<userId>.db`) and one photo folder
  per user (`offline-photos/<userId>/`): never read or send one user's data while another is
  signed in. **Never delete a queued write silently**: only when the server accepted it, when the
  worker discards it, or by the kept-queue rule (an explicit "keep for later" sign-out, after 30
  days). **Every user-facing string goes through `src/i18n`** (`t('...')`, catalogue `en.ts`; a
  new API error code needs a `sync.reasons` text; styles use `start` / `end`, never `left` /
  `right`). **Tokens and the offline identity only in SecureStore**; form drafts in AsyncStorage
  (`src/storage/`), deleted after 14 days. Android Expo Go has no remote push; push
  needs the development build (`expo-dev-client`, `eas.json`, `dev:client`) and
  `EXPO_PUBLIC_EAS_PROJECT_ID`; the background sync task also needs the development build. To
  test offline without a phone, use the emulator `hz_pixel` with `adb reverse` (README section 6).
  Bundle identifiers come from `EXPO_IOS_BUNDLE_IDENTIFIER` /
  `EXPO_ANDROID_PACKAGE`. `eas-build-post-install` builds `@ops/shared` on EAS.

**This file**

- The block below is written and re-added by the `turbo` CLI. Leave it byte-for-byte unchanged and
  keep it at the end of the file. Write project rules above it.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
