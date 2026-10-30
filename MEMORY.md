# MEMORY.md

Current state of the HZ project (repository folder `Operations_App`, packages `@ops/*`). Update this
file at the end of every session. Newest session log entry goes first. Last updated: 2026-10-28.

## Current phase

**Phase 6 (Web manager dashboard) is code complete, tested, and reviewed (2026-10-28), and is about
to be committed and pushed by the coordinator as "Phase 6: ...".** Nobody has used the dashboard
in a browser with data yet (it needs the owner's `pnpm db:reset` first). `main` has Phase 1
(`d03c843`), Phase 2 (`1fd2988`), Phase 3 (`8c8283a`), Phase 4 (`280c50a`), the restore note
(`924446e`), and Phase 5 (`2cf5a01`, pushed). The Phase 5 emulator and phone tests are still open.
**Phase 7 (Intelligent layer v1) is next.** Phases are defined in [ROADMAP.md](ROADMAP.md).

**Before using the apps the owner must run `pnpm db:reset` once**: the development database
`operations_app` holds a stray migration `20261018090000_phase5_offline_sync` from the lost work
and lacks the repository's `20261027090000_phase5_offline_sync` and
`20261028090000_phase6_dashboard`. Agents may not run it.

**On this PC port 3000 is used by another project.** To open the dashboard, set `WEB_PORT` (for
example 3100) in `.env`, add that origin (`http://localhost:3100`) to `CORS_ORIGINS` and use it as
`WEB_APP_URL`, then restart `pnpm dev` (README section 3).

**The owner's local copy was lost and restored from GitHub on 2026-10-27** (folder
`Operations_App_restored`). The first Phase 5 attempt (after 2026-10-17) was never pushed and is
gone; Phase 5 was rebuilt on 2026-10-27. `.env` was recreated from `.env.example`.

**Phase 3 is accepted**: at the start of the Phase 4 session (2026-10-17) the owner reported that
`pnpm db:reset` ran, that sign-in works in the browser for `aylin` (admin), `selin` (supervisor),
and `deniz` (worker), and Phase 3 is committed as `8c8283a`.

**HZ** is the client's product name. Kaneri.ai builds and powers it. "Operations" remains the
technical name of the folder, the packages, the API domain folder, and the database.

## What exists

| Area              | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo          | pnpm 12 workspaces + Turborepo 2. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `format`, `format:check`, `db:up`, `db:down`, `db:logs`, `db:migrate`, `db:seed`, `db:reset`.                                                                                                                                                                                                                                                                                                                                                  |
| Docker Compose    | PostgreSQL 17 and, since Phase 4, MinIO (`alpine/minio`, pinned by digest) for photos. `pnpm db:up` starts both; both bind to `127.0.0.1` by default.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/config` | Shared ESLint 10 flat config, Prettier config, three tsconfig presets. Unchanged since Phase 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/shared` | Zod schemas and endpoint functions for every resource, `/auth/*`, `/notifications`, `/sync/pull`, and since Phase 6 the dashboard, directory, map, histories, exports, report, and user sessions; the offline headers and typed error codes; the transport (refresh once on a 401, per-call headers, text responses); `createAuthSessionManager`; the upload helper; custom-field forms; time-zone, CSV, and locale helpers; the translation core; design tokens.                                                                                               |
| `apps/api`        | NestJS 12 API, 68 paths. Platform: sign-in and sessions, the policy seam, idempotency (`Idempotency-Key`), S3-compatible file storage, notifications, the outbox consumer, audit log (with offline metadata), outbox. Domain: the access layer on every route, row versions and typed conflict codes, the attachment upload flow and cleanup, notification rules rendered in each recipient's `User.locale`, `GET /sync/pull`, and since Phase 6 the overview, directory, bulk review, map, histories, audited CSV exports, report, and session administration. |
| `apps/web`        | Next.js 16.4.3 manager dashboard (Phase 6): `/login`, `/activate`, and behind sign-in an app shell with Overview (`/`), Work logs (list, detail, report), Tasks (list and board, detail), Map, People, Structure (sites, teams, log-type editor), Audit log, Settings; navigation by role; TanStack Query and Table, Leaflet, an i18n layer (English), times in the organization's time zone. Never used in a browser with data.                                                                                                                                |
| `apps/mobile`     | Expo SDK 57 worker app: Home, Tasks, Task detail, New/Edit log (custom fields, photos, location), Logs, Log detail, Notifications, Profile, Sync. Offline since Phase 5: per-user SQLite cache and write queue, photo store, sync engine (NetInfo, foreground, background task), sync indicator and screen, edit drafts. Unchanged in Phase 6 except that the translation core now comes from `@ops/shared`. Never run on a phone or emulator.                                                                                                                  |
| Database          | PostgreSQL in Docker on `127.0.0.1` (port 5433 on this PC). `operations_app` has the four migrations up to Phase 4, the Phase 3 seed, and a stray `20261018090000_phase5_offline_sync` from lost work; `20261027090000_phase5_offline_sync` and `20261028090000_phase6_dashboard` are not applied to it (needs `pnpm db:reset`). `operations_app_test` is rebuilt by the integration tests.                                                                                                                                                                     |
| Docs              | `AGENTS.md`, this file, `ARCHITECTURE.md` (with the permissions matrix), `ROADMAP.md`, `README.md` (including the web dashboard, "Test on my phone", and "Test offline mode in the Android emulator"), ADR-0001 to ADR-0009, a `memory.md` in each app and package, the phase prompts in `docs/prompts/`, the coordinator's `docs/reports/phase-5.md` and `phase-6.md`, the logo files in `docs/brand/`.                                                                                                                                                        |
| Subagents         | `reviewer`, `docs-keeper`, `test-writer` in `.claude/agents/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Not built yet: activation deep links into the app, photo upload from the browser (deferred to
Phase 8), Turkish and Arabic catalogues, real email or SMS delivery of codes, encryption of the
phone's local database, and the AI layer. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Signing in

- Users sign in with an email, phone number, or username plus a password (`POST /auth/login`,
  `client: 'web'` for cookies or `'mobile'` for bearer tokens).
- Demo users: identifiers per role are in README section 4. **Development passwords are defined
  only in the `DEV_PASSWORDS` constant in `apps/api/src/operations/seed/demo-seed.ts`**, one per
  role. Never copy them into a document, a log, or chat output.
- New users get a one-time activation code from an admin (`POST /users`); in development the code
  and link are in the response and the API log. Reset codes: `POST /users/:id/password-reset`.
- The development database has the Phase 3 seed (the owner ran `pnpm db:reset` before
  2026-10-17), but its migration history diverges (see Current phase), so the Phase 5 and Phase 6
  API needs the owner's `pnpm db:reset` first. The seed has no photos and no notifications.
- The dashboard is for supervisors, managers, and admins; a worker who signs in on the web sees
  "use the mobile app". Admins (`aylin`) manage people, the audit log, and settings; managers
  (`murat`) see everything read-only in People; supervisors (`selin`, `emre`) see their scope.

## Verified

**Phase 3 acceptance (owner, reported 2026-10-17)**: `pnpm db:reset` ran; sign-in works in a real
browser for `aylin`, `selin`, and `deniz`; Phase 3 committed (`8c8283a`). The rest of the Phase 3
manual list (Swagger per role, activation, lockout, sign-out everywhere) is not recorded as run.

**In the Phase 6 session (2026-10-28)**, as reported by the coordinator unless a line says
otherwise:

- Unit tests (re-run by the docs-keeper with `pnpm test` on 2026-10-28, all pass): 743
  `@ops/shared` (17 files), 527 `@ops/api` (25 suites), 174 `@ops/web` (11 files), 305
  `@ops/mobile` (26 suites).
- Integration tests: 1,534 in 21 suites (new: `dashboard`, `dashboard-scope`). Not re-run by the
  docs-keeper.
- `pnpm build`, `lint`, `typecheck`, `test:integration`, and `format:check` pass.
- The test-writer's 58 new tests found no bug. They cover scope for supervisor, manager, and admin
  on every new data source (changed ids and query parameters, foreign records 404), no
  self-approval single and bulk, exports equal to the lists and audited, log-type versioning, CSV
  injection, time zones (half-hour offsets, daylight-saving days, the organization's "today"),
  per-user languages with English fallback, sessions admin only.
- The reviewer's "pass with fixes", nothing blocking; the fixes are in the session log.
- A smoke test only of the web app (every route answers, security headers present); no browser
  session with data.

**In the Phase 5 session (2026-10-27)**, as reported by the coordinator unless a line says
otherwise:

- Unit tests: 689 `@ops/shared` (14 files), 513 `@ops/api` (24 suites), 46 `@ops/web`, 305
  `@ops/mobile` (26 suites). The docs-keeper re-ran `pnpm test`, `pnpm lint`, and `pnpm typecheck`
  on 2026-10-27 (all pass; mobile then had 304, the 305th test, a guard against discarding an item
  being sent, was added afterwards).
- Integration tests: 1,416 in 19 suites (new: `offline-sync`, 62 tests). Not re-run by the
  docs-keeper.
- `prisma migrate status` on 2026-10-28 (docs-keeper): the development database lacks
  `20261027090000_phase5_offline_sync` and holds the stray `20261018090000_phase5_offline_sync`.
- The reviewer's "pass with fixes"; the fixes are in the session log.

**In the Phase 4 session (2026-10-16 to 2026-10-17)**, as reported by the coordinator and the
agents unless a line says otherwise:

- Root install, build, lint, typecheck, test, `test:integration`, and `format:check` pass
  (2026-10-17). The migration `20261017090000_phase4_mobile` is applied to the development
  database.
- Unit tests: 477 in `@ops/api` (21 suites), 650 in `@ops/shared` (13 files), 154 in
  `@ops/mobile` (15 suites), 46 in `@ops/web` (3 files). The docs-keeper re-ran each package's
  test runner on 2026-10-17 and confirmed these counts.
- Integration tests: 1,339 in 18 suites, including the new `uploads`, `storage-minio` (real
  MinIO, bucket `hz-attachments-test`), `worker-app`, and `notifications`. Not re-run by the
  docs-keeper.
- Storage against the real MinIO (`storage-minio` suite): bucket creation at start-up, upload
  through the signed URL, complete, original and thumbnail served by signed URL only, a PUT to the
  old URL after complete changes nothing served (EXIF and appended data gone), another type or
  size refused by the storage, refused content deleted with 422, expired URL refused and a renewed
  one accepted.
- Notifications live on an agent-started API: a task assignment produced the in-app notification
  within about one second; the push token was removed on sign-out.
- The mobile repositories, run end to end against the real API (outside a phone): a log with
  custom fields, a duplicate `clientId`, a photo upload, a rejection and its notification.
- `expo export` and `expo-doctor` 21/21.
- A security review returned "pass with fixes"; the fixes are in the session log.

## Not yet verified

1. **Anything on a phone or in the emulator**: the screens, camera and gallery, location,
   SecureStore, push, and all of Phase 5 on a device (SQLite, the file system, NetInfo, the
   background task, airplane mode, the conflict case). Only test fakes cover them. The owner can
   use the emulator `hz_pixel` (README section 6) or the phone's hotspot (README section 5).
2. **The Phase 5 and Phase 6 migrations on the development database** (after the owner's
   `pnpm db:reset`).
3. **The web dashboard in a real browser** with the seed data, as `aylin` (admin), `selin`
   (supervisor), and `murat` (manager): the manual list in `docs/reports/phase-6.md`, phone and
   desktop widths, keyboard use, print preview of the report, a CSV opened in Excel, the map
   tiles.
4. **A development build**: configured (`expo-dev-client`, `apps/mobile/eas.json`), never built
   or installed. It needs the owner's Expo account and `eas init`. Push and background sync need
   it.
5. **Real push delivery through Expo** (only a fake Expo client in tests).
6. **AWS S3 or any provider other than MinIO.**
7. The web "API status" card's automatic recovery, watched by a person (the card is on the
   Settings page since Phase 6).

## Machine and repository state

- Node 24.20.0, pnpm 12.11.2, Git 2.55, Docker Desktop with the WSL 2 backend. Windows long paths
  enabled.
- Containers `operations-app-postgres-1` and `operations-app-minio-1` run (both healthy on
  2026-10-27). Docker Desktop stopped on its own once on 2026-10-13 (cause unknown).
- **Port 5432 on this PC is taken** by a portable PostgreSQL of another project (Kaneri Tender
  Intelligence Platform). Since 2026-10-27 the local `.env` uses `POSTGRES_PORT=5433` and port
  5433 in `DATABASE_URL` and `DATABASE_URL_TEST`; the container was recreated with that mapping
  (data volume kept). `.env.example` still shows 5432, the default.
- The `ops` database user's password in the container volume was set to the new `.env` value on
  2026-10-27 (the old `.env` was lost with the local copy).
- **The development database `operations_app` still holds a migration from the lost Phase 5 work
  (`20261018090000_phase5_offline_sync`) that is not in the repo, and lacks
  `20261027090000_phase5_offline_sync`** (`prisma migrate status`, 2026-10-28) **and
  `20261028090000_phase6_dashboard`**. It needs the owner's `pnpm db:reset` (agents may not run
  it). The test database is rebuilt by the integration tests.
- **Port 3000 on this PC is taken** by another project. Run the dashboard on another `WEB_PORT`
  (for example 3100) with that origin in `CORS_ORIGINS` and `WEB_APP_URL` (README section 3).
- Android SDK under `%LOCALAPPDATA%\Android\Sdk` with the emulator and `adb`; the virtual device
  `hz_pixel` (Android 35, Google APIs, x86_64) exists. `ANDROID_HOME` is not set system-wide
  (README section 6 sets it in the Expo terminal). Never started for this project yet.
- Branch `main`, six commits up to `2cf5a01` (Phase 5), in sync with `origin/main` (private GitHub
  repository `wesamalhroubuni-rgb/hz-operations-app`); the Phase 6 work is uncommitted at the time
  of writing (2026-10-28).
- The local `.env` (git-ignored) was recreated from `.env.example` on 2026-10-27 (development
  placeholders). `EXPO_PUBLIC_EAS_PROJECT_ID` is empty until the owner runs `eas init`.
- User ids are generated, so they change on every reset. Sign in with identifiers instead.

## Known limitations

Security (accepted for now; see ADR-0004 to ADR-0008)

- **Rate limits are in memory, per process** (sign-in and, since Phase 4, upload steps), and so is
  the image-decode limit. Several API instances count separately; a restart forgets everything. A
  shared store is needed before scaling out (Phase 8).
- **Lockout is a targeted denial of service** (F4).
- **Behind a reverse proxy, `TRUST_PROXY_HOPS` must be set exactly.**
- **One-time codes are not delivered** (logged in development only).
- **Orphan upload bytes**: after an attachment is complete, a client that still holds its upload URL
  can PUT again within the URL lifetime (300 s); those bytes are never served and nothing removes
  them (ADR-0006).
- **Purge window**: upload bytes of attachments archived while pending are purged for 48 hours
  after their URL expired; a longer storage outage leaves them behind.
- **A lost `startUpload` answer** of a start without an attachment `clientId` (the phone always
  sends one since Phase 5) can leave a second pending attachment (visible only to the
  uploader) until the cleanup archives it after 24 hours.
- **Push-token rebinding** is accepted: whoever registers a token last receives its pushes
  (audited, ADR-0007).
- **Push receipts are kept in memory**; a restart forgets them.
- **`clientId` reuse by another user answers 409** (F7, accepted as negligible).
- **No `script-src` / `style-src` Content-Security-Policy on the web app** yet.
- The refresh-token grace window (10 seconds).
- Permission denials (403, 404) are not written to the audit log.
- The audit log is append-only, so personal data in it cannot be erased; the trigger does not block
  `TRUNCATE`. Stored photos have no retention rule either.
- Tenancy and scope are enforced in application code only.
- `pnpm db:reset` has no guard on its target.
- Production needs HTTPS (including `STORAGE_PUBLIC_ENDPOINT`), the web app and the API on the
  same site (or `AUTH_COOKIE_DOMAIN`), the exact web origin in `CORS_ORIGINS`, and a private bucket
  created beforehand.

Behaviour

- **Offline (ADR-0008)**: the phone's SQLite database and photo folder are protected only by the
  app sandbox and device encryption (no SQLCipher). An edit resent after its idempotency key
  expired (14 days), whose log was approved meanwhile, shows as refused (`already_reviewed`)
  although it took effect; the worker discards it. Approved logs can still receive declared
  photos for 30 days. An offline create whose task, site, or team is no longer usable is stored
  without that link (reported and audited). A user whose session expired and who was replaced by
  another user on the phone keeps their queue until they sign in again (never swept
  automatically). Background sync is best effort and needs the development build. Logs older
  than 30 days and photos already on the server need a connection.
- **Notification text** is rendered on the server in the recipient's `User.locale` (`en`, `tr`,
  `ar` allowed), but only the English catalogue exists: other languages fall back to English key
  by key. The push shows generic text. The dashboard itself is English only (`LOCALE` fixed).
- **Dashboard (ADR-0009)**: photos cannot be uploaded from the browser (deferred to Phase 8: a
  CORS rule on the bucket). The directory is capped at 5,000 entries per kind; exports are
  synchronous and capped at 10,000 rows (422 `export_too_large`); the report covers at most 92
  days; overview aggregates are computed on read. The API accepts a changed log-type field key;
  only the editor prevents it. Log types cannot be restored once archived. Requiring a site or
  team for worker and supervisor memberships is a dashboard rule only. The map uses the public
  OpenStreetMap tiles unless `NEXT_PUBLIC_MAP_TILE_URL` is set (their usage policy forbids heavy
  use). The CSP still has no `img-src` / `connect-src`.
- Redaction in audit and outbox events is by key name at any depth.
- Old log type definitions are not kept; `logTypeVersion` resolves only through the audit log.
- Row versions on tasks and work logs only; other resources are last-write-wins, and so are task
  and log writes that send no `expectedVersion` (the web and online screens).
- Outbox sequence numbers are assigned at insert; the consumer's 60-second settle rule covers
  late commits, and it re-reads that window on every poll.
- Scope resolution reads every membership, site, and team of the organization once per request.
- Only users, sites, and teams can be restored.
- Every authenticated request reads the session and the user from the database.
- `/health` logs an error on every call while the database is down.

Clients and tooling

- The first sign-in on a phone needs the server; after that the app opens offline from the stored
  identity and cache.
- To test offline on this PC use the emulator with `adb reverse` (README section 6); in airplane
  mode `adb reverse` may still reach the PC, so stop the API for a strict test.
- Activation links open the web page, not the app (no deep links).
- **Android Expo Go cannot receive remote push** (since SDK 53); push on Android needs the
  development build. iOS Expo Go can receive push with an EAS project id.
- Expo Go shows its own icon and splash and ignores the config plugins.
- The mobile bundle identifiers come from `EXPO_IOS_BUNDLE_IDENTIFIER` and `EXPO_ANDROID_PACKAGE`;
  the default `ai.kaneri.operations` is a placeholder until the owner decides.
- A phone test needs `API_HOST=0.0.0.0`, `MINIO_BIND_HOST=0.0.0.0`, and the PC's address in
  `EXPO_PUBLIC_API_URL` and `STORAGE_PUBLIC_ENDPOINT` (README section 5); switch them back
  afterwards.
- `pnpm db:logs` follows PostgreSQL only; for MinIO use `docker compose logs -f minio`.
- `expo start --tunnel` is not available (no `@expo/ngrok`).
- `.env` is a global Turbo dependency, so editing any value invalidates every cached task.
- Root `pnpm dev` runs Expo under Turbo, where the QR code may not appear; run
  `pnpm --filter @ops/mobile dev` in its own terminal.
- `nest build` deletes `apps/api/dist`, which breaks a running `pnpm dev` API until it recompiles.
- Integration tests are not part of `pnpm test` and there is no CI pipeline.
- Product-name leftovers in code: the `description` fields in the `package.json` files and the
  Swagger description in `apps/api/src/main.ts` still say "Operations App".

## Open questions

- Before the first store build: the final mobile bundle identifiers, and which Expo account owns
  the EAS project.
- With the owner (ADR-0008): is the 30-day kept-queue period right, and should the phone's local
  database be encrypted (SQLCipher) before production?
- Which deep-link scheme or universal link should activation links use, so they open the app, and
  in which phase?
- Who translates the Turkish and Arabic catalogues (web, mobile, notifications), and when?
- Before production: which map tile provider (`NEXT_PUBLIC_MAP_TILE_URL`)?
- Before production: which object storage provider and region, what retention for photos, and
  who may erase them? Which email or SMS provider delivers one-time codes? Who in the client's
  organization holds the admin role?
- Before production: is the lockout acceptable as is (F4)? Should 403 and 404 answers be audited?
- Phase 7: which AI provider and hosting constraints (data residency, cost limits)?
- Before Phase 8: retention and erasure of personal data in the audit log and the outbox
  (including the IP addresses and user agents stored on sessions).
- Before a second client: does tenancy need database-level enforcement?
- Why did Docker Desktop stop on its own on 2026-10-13?

Answered in Phase 4 (see [ADR-0006](docs/decisions/0006-file-storage-and-upload-flow.md) and
[ADR-0007](docs/decisions/0007-push-notifications-and-notification-channels.md)): the storage
approach (S3-compatible, MinIO in development, direct signed uploads verified on completion) and
the size limit (10 MiB, configurable); the push provider (Expo push, behind a channel interface);
how the outbox consumer avoids missing late-committing events (the 60-second settle rule); where
the mobile bundle identifiers come from (environment variables).

Answered in Phase 5 (see [ADR-0008](docs/decisions/0008-offline-storage-sync-and-conflicts.md)):
the local database (SQLite, one per user), the conflict rule (server is the source of truth, typed
refusals, the supervisor's change wins), row versions on tasks and work logs, and the session
rule (an unreachable server never signs out; a refused refresh keeps the queue and asks to sign
in again).

Answered in Phase 6 (see [ADR-0009](docs/decisions/0009-web-dashboard-architecture.md)): the admin
screens (People with invitations, codes shown once, memberships, sessions, archive and restore;
Structure; Settings; Audit log) and where a user's language is stored (`User.locale`, default
`en`, changed by the user or an admin).

## Session log

### 2026-10-28: Phase 6 web manager dashboard

- **What changed**
  - Database: migration `20261028090000_phase6_dashboard` (`User.locale`, default `en`);
    `settings.timeZone` in the organization settings JSON (IANA name, default
    `Europe/Istanbul`), carried in the organization summary as `timeZone`.
  - API: 11 new paths (68 in all): `GET /dashboard/overview`, `GET /directory`,
    `GET /work-logs/map`, `POST /work-logs/bulk-status`, `GET /work-logs/:id/history`,
    `GET /tasks/:id/history`, `GET /exports/work-logs.csv`, `GET /exports/tasks.csv`,
    `GET /reports/work-logs`, `GET /users/:id/sessions`, `POST /users/:id/sessions/revoke`. Six
    policies (supervisor, manager, admin): `dashboard.read`, `directory.read`, `work_log.review`,
    `export.work_logs`, `export.tasks`, `report.read`. New modules `dashboard/`, `exports/`,
    `reports/`, `history/`; one filter builder per resource (`work-log-query.ts`,
    `task-query.ts`) used by the list, map, export, report, and overview; list filters `search`,
    `hasPhotos`, `excludeOwn`, `open`, `overdue` and more sort fields; exports audited through the
    audit-only `ChangeRecorder.recordAccess` (no outbox event), capped at 10,000 rows, safe
    against formula injection; `AuthAdminService.listUserSessions`; `locale` on users (a user may
    change their own `displayName` and `locale`); notifications rendered per recipient locale.
  - `@ops/shared`: the schemas and endpoints above (`domain/dashboard.ts`, `directory.ts`,
    `exports.ts`, `history.ts`, `reports.ts`), `common/time-zone.ts`, `common/csv.ts`,
    `common/locale.ts`, the translation core moved from mobile (`src/i18n/translate.ts`), error
    code `export_too_large` (422), transport `responseType: 'text'`.
  - Web: the whole dashboard (see `apps/web/memory.md`). New dependencies at exact versions:
    `@tanstack/react-query` 5.104.3, `@tanstack/react-table` 8.21.3, `leaflet` 1.9.4,
    `react-leaflet` 5.0.0, `@types/leaflet` 1.9.22. Next.js and `eslint-config-next` updated from
    16.4.0 to 16.4.3 (within the `~16.4` pin) after a security notice in the build. The
    placeholder home page was deleted.
  - Mobile: `src/i18n/translate.ts` re-exports the shared core; one catalogue key.
  - Configuration: `NEXT_PUBLIC_MAP_TILE_URL` (optional; empty means the public OpenStreetMap
    tiles) in `.env.example`, `apps/web/src/lib/env.ts`, and `turbo.json`.
  - Docs: ADR-0009 (accepted, with an "as built" section); every document updated; the
    coordinator wrote `docs/reports/phase-6.md` (with the browser test list).
- **Why**: Phase 6 of the roadmap (`docs/prompts/phase-6.md`): supervisors, managers, and admins
  run the operation from the browser, strictly within their Phase 3 scope.
- **How it was built**: a contracts and foundation agent first (ADR-0009, the migration, the
  shared contracts and helpers, the web shell, building blocks, and placeholder pages), then three
  parallel agents: A (API), B (overview, work logs, map, report, exports), C (tasks, people,
  structure, audit, settings); then the `test-writer`, the `reviewer`, and the `docs-keeper`.
  - The test-writer added 58 tests and found no bug. Decision taken: the API does not refuse a
    changed log-type field key (a rename cannot be told apart from remove plus add); the editor
    locks saved keys and refuses a new field that reuses a saved key.
  - The reviewer returned "pass with fixes", nothing blocking. Fixed: a photo refetch loop when
    the storage is unreachable; formatting; the "unknown place" label; "awaiting approval"
    counted the caller's own logs (new `excludeOwn` filter); reuse of a saved field key in the
    editor; pages briefly rendered with the default time zone (the shell now waits for the
    organization's time zone); `left` / `right` CSS on the login and activation pages (now
    logical properties); dead code. Documented: browser photo upload deferred (Phase 8).
- **Verified**: see "Verified" above (unit counts re-run by the docs-keeper; integration 1,534 in
  21 suites as reported).
- **Left to do**
  - Owner: `pnpm db:reset`; the browser test (`docs/reports/phase-6.md`) on a free `WEB_PORT`
    (port 3000 is taken on this PC); the Phase 5 emulator and phone tests.
  - Coordinator: commit "Phase 6: ..." and push.
  - Later: Turkish and Arabic catalogues and a per-user dashboard language; browser photo upload
    and a nonce-based CSP with `img-src` (Phase 8); restoring archived log types.

### 2026-10-27: Phase 5 offline mode and sync

- **What changed**
  - Database: migration `20261027090000_phase5_offline_sync`. `Task.version`, `WorkLog.version`,
    `submittedOffline`, `deviceCreatedAt`, `clockSkewSeconds`, `declaredAttachmentClientIds`;
    `Attachment.clientId` (unique per organization); `AuditEvent.metadata`; platform table
    `IdempotencyRecord`; organization setting `offlineMaxBackdateDays` (default 7).
  - API platform: `src/platform/idempotency/` (`@Idempotent()`, global interceptor, hourly
    expiry); the request context reads `x-client-sync` and `x-device-time`; `AuditService` writes
    the offline metadata; CORS allows and exposes the new headers.
  - API domain: row versions and `expectedVersion` with the no-op rule
    (`common/concurrency.ts`, row locks); ten typed error codes; offline creates (backdating
    limit, dropped references, clock skew); declared photos for 30 days, renew and complete for 30
    days; `src/operations/sync/` (`GET /sync/pull`, policy `sync.pull`, cursor with a scope
    fingerprint). 57 paths.
  - `@ops/shared`: `domain/sync.ts`, `platform/offline-sync.ts` (headers, clock skew), the new
    codes with `API_ERROR_STATUS` and `RETRYABLE_API_ERROR_CODES`, body and response fields,
    per-call headers in the transport, `sync` in `createApiClient`.
  - Mobile: `src/offline/` (per-user SQLite store, write queue, photo store, sync engine, NetInfo,
    background task, offline identity, lifecycle and sweep, migration of the Phase 4 upload
    queue); repositories write to the queue; reads from the cache with the queue on top; sync
    indicator, banners, Sync screen, per-log state, sign-out dialog; edit-form drafts. New
    packages `expo-sqlite`, `expo-background-task`, `expo-task-manager`,
    `@react-native-community/netinfo`; `expo` ~57.0.31 and Expo patch updates.
  - Docs: ADR-0008 (amends ADR-0005 and ADR-0006 in part), README section 6 (Android emulator),
    every document updated; the coordinator wrote `docs/reports/phase-5.md`.
- **Why**: Phase 5 of the roadmap (`docs/prompts/phase-5.md`): workers with weak or no signal
  keep working, and every change reaches the server exactly once under the normal permissions.
- **How it was built**: a contracts agent first (schema, `@ops/shared`, `src/offline/types.ts`,
  ADR-0008), then three parallel agents (backend; mobile store and queue; sync engine and UI),
  then the `test-writer`, the `reviewer`, and the `docs-keeper`.
  - The test-writer found a double-save bug (fixed).
  - The reviewer returned "pass with fixes". Blocking, fixed: the engine sent a stale copy of a
    queued item (an edit merged meanwhile could be lost); `markSending` now returns the current
    copy. Major, fixed: the clientId-to-server-id link was lost when the cache was cleared (now
    kept with the queue, `linkServerId`). Minor, fixed: a photo deleted before the upload was
    recorded done, partial photo saves, the sweep deleting users who never chose to keep their
    queue, drafts left after sign-out, the background task not unregistered, Expo patch drift.
    Documented: an edit replayed after its log was approved shows as refused.
  - Coordinator decision: only a queue the user explicitly kept with "keep for later" at sign-out
    ages out, after 30 days; a user replaced while their session had expired keeps their queue
    until they sign in again.
  - After the review, a guard was added so an item already being sent cannot be discarded (mobile
    tests 304 to 305).
- **Verified**: see "Verified" above (unit and integration counts, lint and typecheck re-run by
  the docs-keeper, `prisma migrate status`).
- **Left to do**
  - Owner: `pnpm db:reset`; the emulator test (README section 6) including the conflict case;
    the phone test; the development build for push and background sync.
  - Coordinator: commit "Phase 5: ..." and push.
  - Later: encryption of the local database and the 30-day kept-queue period (with the owner);
    Phase 6 web screens to review synced logs (showing "sent offline" and the clock warning).

### 2026-10-27: Restore after local data loss

- The owner's local copy was lost. The repository was cloned again from GitHub (`main` at
  `280c50a`, Phase 4) into `Operations_App_restored`. Any Phase 5 work after 2026-10-17 was never
  pushed and is lost.
- Recreated `.env` from `.env.example`. Moved the local database to port 5433 (5432 is taken by
  another project's PostgreSQL on this PC) and set the container's `ops` password to the new
  `.env` value.
- Verified on 2026-10-27: `pnpm install`, `build`, `lint`, `typecheck`, `test` (477 api unit tests
  and the other packages), and `test:integration` (1,339 tests in 18 suites) pass.
- Open: the owner's `pnpm db:reset` (the development database holds the lost Phase 5 migration);
  the Phase 4 phone test.

### 2026-10-16 to 2026-10-17: Phase 4 mobile worker app, file storage, notifications

- **Starting point**: the owner reported Phase 3 verified in the browser (`pnpm db:reset` ran;
  sign-in works for `aylin`, `selin`, `deniz`) and committed (`8c8283a`).
- **What changed**
  - Database: migration `20261017090000_phase4_mobile`. `Task.statusReason`;
    `WorkLog.reviewedById`, `reviewedAt`, `reviewNote`; `Attachment.status` (`pending`, `ready`),
    `thumbnailKey`, `width`, `height`, `completedAt`; platform tables `Notification` (unique
    `(sourceEventId, recipientId, type)`), `PushToken` (unique `token`, bound to `sessionId`),
    `OutboxConsumerCursor`; enums `AttachmentStatus`, `PushPlatform`.
  - API platform: `src/platform/storage/` (`FileStorage` moved here from `src/operations/storage`,
    `S3FileStorage` with an internal and a signer client, `images.ts`, `concurrency.ts`,
    `storage-settings.ts`); `src/platform/notifications/` (`NotificationChannel`,
    `NotificationService`, the `/notifications` routes, `PushTokenService`, `ExpoPushClient`,
    `ExpoPushChannel`); `src/platform/outbox/outbox-consumer*.ts`; a session-end hook in
    `SessionService`; the request log masks the push token path.
  - API domain: the attachment upload flow (start, renew, complete with verification and
    re-encoding, signed URLs) and the hourly cleanup and purge; pending attachments visible only
    to their uploader; `PATCH /tasks/:id/status` takes `{ status, reason? }` and
    `PATCH /work-logs/:id/status` `{ status, note? }`, with richer outbox payloads;
    `src/operations/notifications/` (rules, English catalogue, handler registration). The seed
    gives the blocked task a reason and the rejected logs a note.
  - `@ops/shared`: attachment schemas without storage keys and with the upload endpoints;
    `platform/notifications.ts`; task `statusReason` and work log `review`; the change-status
    bodies; `api-client/attachment-upload.ts`; `forms/custom-field-form.ts`.
  - Mobile: the whole worker app (see `apps/mobile/memory.md`), with React Navigation, TanStack
    Query, AsyncStorage, the Expo camera, image, file, location, localization, and notification
    modules, and `expo-dev-client`; `eas.json`; scripts `dev` (`expo start --go`), `dev:client`,
    and `eas-build-post-install`; `expo` bumped to ~57.0.30 and `expo-constants` ~57.0.22.
  - Configuration: the `STORAGE_*`, `UPLOAD_*`, `DOWNLOAD_URL_TTL_SECONDS`, `EXPO_ACCESS_TOKEN`,
    `PUSH_ENABLED`, `OUTBOX_*`, `MINIO_*`, `EXPO_PUBLIC_EAS_PROJECT_ID`,
    `EXPO_IOS_BUNDLE_IDENTIFIER`, and `EXPO_ANDROID_PACKAGE` variables in `.env.example`, the API
    validation, and `turbo.json` (the `MINIO_*` ones are read by Docker Compose only). Docker
    Compose: the `minio` service and volume. New API dependencies: `@aws-sdk/client-s3`,
    `@aws-sdk/s3-request-presigner`, `sharp` (prebuilt, no install script, so no `allowBuilds`
    change).
  - Docs: ADR-0006 (file storage and upload flow; amends ADR-0005 in part) and ADR-0007 (push
    notifications, channels, outbox consumer); every document updated for Phase 4, including a
    "Test on my phone" section in the README.
- **Why**: Phase 4 of the roadmap, as specified in `docs/prompts/phase-4.md`: a worker can use HZ
  on a phone for real work, with photos, location, custom fields, and notifications.
- **How it was built**: three parallel subagents (storage, notifications, mobile) on contracts the
  coordinator fixed first (schema, shared schemas, configuration), then the `test-writer`, then
  the `reviewer` as a security reviewer, then the `docs-keeper`.
  - The test-writer found and the team fixed: the edit form wiped the custom fields of a log whose
    log type was archived; a push token was logged when the path had a different letter case; the
    cleanup could delete a photo completed a moment earlier (it now claims the row first); a race
    when two instances created the first consumer cursor. Rule changes from that work: a reviewer
    may repeat a decision to correct the note; a blocked task can be blocked again with a new
    reason.
  - The security review returned "pass with fixes". Fixed: M1, a verified photo could be
    overwritten through a still-valid upload URL (now re-encoded to an API-only key); M2, rate
    limits on the upload steps, the decode limit, and the purge; L1, generic push text; L2,
    re-registration of push tokens; L3, no hot loop in the consumer under a burst; L4, the MinIO
    image pinned by digest; L5, 14-day retention of drafts and queued photos on the phone; L6, no
    notification for a repeated approval. Accepted and documented: push-token rebinding, orphan
    upload bytes, per-process limits, server-rendered notification text in English only.
- **Verified**: see "Verified" above.
- **Left to do**
  - Owner: the phone test (README section 5) as `deniz` and `selin`; create the Expo account, run
    `eas init`, build and install the Android development build for push; decide the bundle
    identifiers; review and commit. The next `pnpm db:up` recreates the MinIO container because
    the image is now pinned by digest (the data stays in its volume).
  - Coordinator: the final `pnpm dev` check with MinIO and the web app.
  - Carried to Phase 5: the offline log queue behind the repositories, drafts for the edit form,
    a `pending` `SavedWorkLog`, the signed-in state when the server is unreachable.
  - Carried to Phase 6: photo upload from the web (CORS on the bucket), localised notification
    text. Phase 7: AI alerts through the channel interface. Phase 8: a shared rate limiter,
    durable push receipts (`PushTicket`), a purge marker for orphan bytes, a real S3 provider and
    bucket policy, a replacement for the MinIO image, retention and erasure of photos.
  - Not placed in a phase yet: activation deep links into the app.

### 2026-10-14 to 2026-10-16: Phase 3 authentication and permissions

- **Starting point**: on 2026-10-14 the owner reviewed the Phase 2 report and asked to proceed;
  that review is the record of the Phase 2 manual checks. Phase 2 was already committed
  (`1fd2988`).
- **What changed**
  - Database: migration `20261014090000_auth`. `User.email` optional, new `User.username`, unique
    phone and username per organization; platform tables `AuthCredential`, `AuthOneTimeCode`,
    `AuthSession`, `AuthRefreshToken` (hashes only, no foreign keys to business tables).
  - API platform: `src/platform/auth/` (the one global `AuthGuard`, `/auth/*` endpoints, JWT
    access tokens on `node:crypto`, rotating refresh tokens with reuse detection, cookies for web
    and bearer for mobile, CSRF, argon2id via `@node-rs/argon2`, one-time codes, rate limiter,
    lockout, `AuthAdminService`), `src/platform/authz/` (`@Policy`, `@Authenticated`,
    `@DevelopmentOnly`, `REQUEST_AUTHORIZER`), `src/platform/notifications/`. The
    `src/platform/dev-auth/` folder, `DEV_AUTH_ENABLED`, and `DEV_USER_HEADER` were deleted.
  - API domain: `src/operations/access/` (policy registry, `AccessService`, pure rules, one
    visibility definition per resource); every controller route declares a policy; services take
    the caller from `AccessService.context()`; role-shaped user and organization responses; new
    routes `POST /users/:id/activation-code` and `POST /users/:id/password-reset`; `POST /users`
    returns the activation code; the last-admin guard; session revocation on archive and
    membership reduction. `resolveScope` gained `colleagueIds` and reads manager and admin
    memberships as organization-wide.
  - Seed: usernames for everyone, two phone-only workers, development passwords in
    `DEV_PASSWORDS` (never printed), manager and admin organization-wide, back-dated work logs so
    the edit window can be tried, approved and rejected logs; in production no passwords and
    activation codes instead. The seed prints identifiers, not ids.
  - `@ops/shared`: `platform/auth.ts` (wire contract), transport auth hooks with refresh-once,
    `createAuthSessionManager`, `auth-text.ts`, `auth-forms.ts`, `create-api-client.ts`; user,
    organization, membership, scope, and work log schemas updated; `rate_limited` error code.
  - Web: `/login`, `/activate`, protected `/`, `AuthProvider` with a client-side route guard,
    sanitised `next` redirect, security headers. Mobile: Login, Activate, Home, Loading screens,
    SecureStore token storage, `expo-secure-store` ~57.0.4 and its config plugin.
  - Configuration: new `AUTH_*` variables, `WEB_APP_URL`, `TRUST_PROXY_HOPS`,
    `NEXT_PUBLIC_ORGANIZATION_SLUG`, `EXPO_PUBLIC_ORGANIZATION_SLUG` in `.env.example`, the app
    validations, and `turbo.json`; `DEV_AUTH_ENABLED` removed.
  - Docs: ADR-0004 and ADR-0005 (ADR-0002 marked as amended in part); every document rewritten for
    Phase 3, with the permissions matrix in ARCHITECTURE.md.
- **Why**: Phase 3 of the roadmap, as specified in `docs/prompts/phase-3.md`: replace the
  development header with real sign-in and enforce on every route who can see and do what.
- **How it was built**: three parallel subagents (authentication, authorization, clients), then
  the `test-writer`, then the `reviewer` as an adversarial security reviewer, then the
  `docs-keeper`.
  - The test-writer found and the team fixed: phone normalisation differed between the API and
    `@ops/shared` (`(+90) ...` lost its `+` in one of them); the "session expired" notice was lost
    when several requests got a 401 at once; archived tasks still made their sites and people
    visible.
  - The security review returned "pass with fixes". Fixed: concurrent wrong passwords could clear
    an active lockout (F1, now a conditional update, covered by a burst test); slug-less sign-in
    allowed a cross-tenant block or probe once a second organization exists (F2, the slug rule);
    per-IP limits were wrong behind a proxy (F3, `TRUST_PROXY_HOPS`); the outbox route was
    detectable in production (F6, `@DevelopmentOnly()` answers 404 before authentication).
    Accepted and documented: lockout as targeted denial of service (F4), client-chosen attachment
    `storageKey` until Phase 4 (F5, resolved in Phase 4), the `clientId` 409 oracle (F7).
  - Coordinator decision: logout relies on the Origin check alone (no CSRF token), so it works
    with an expired access token; the worst case is a forced sign-out.
- **Verified** on 2026-10-16: root install (frozen lockfile), lint, typecheck, test,
  test:integration (1,208 tests in 14 suites), and format:check; unit counts 367 api, 546 shared,
  46 web, 20 mobile; the auth migration applied; agents' HTTP and browser checks; the security
  review.
- **Left at the time**: the owner's `pnpm db:reset`, browser sign-in, manual checks, `pnpm build`,
  and the commit. On 2026-10-17 the owner reported `db:reset`, the browser sign-in for three
  roles, and the commit (`8c8283a`) as done.

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
    client. Mobile `app.json` was replaced by `app.config.ts`.
  - Seed: `pnpm db:seed` (demo organization "HZ Demo", slug `hz-demo`, idempotent) and
    `pnpm db:reset`.
  - Tests: unit tests grew from 16 to 946; a new integration suite of 532 tests.
  - Configuration: `DEV_AUTH_ENABLED` (removed in Phase 3), `DATABASE_URL_TEST`, the brand-name
    variables; `API_HOST` changed to `127.0.0.1`. New dependencies: `@nestjs/swagger` and `tsx`
    (API), `expo-splash-screen` and `expo-system-ui` (mobile).
  - Docs: every document rewritten for Phase 2; ADR-0002 and ADR-0003 added.
- **Why**: Phase 2 of the roadmap, as specified in `docs/prompts/phase-2.md`.
- **How it was built**: three parallel subagents (domain API, platform modules, branding), then
  the `test-writer`, then an independent `reviewer` ("pass with fixes", no blockers), then the
  `docs-keeper`. The test-writer's fixes included `LIKE` escaping, an outbox cursor 500, outbox
  redaction, ancestor-scope visibility, the per-organization storage key, strict request bodies,
  and exclusive upper date bounds.
- **Verified** on 2026-10-13: root install, lint, typecheck, test, test:integration, build, and
  format:check; both migrations applied; the seed ran once; the dev-header boot refusal; the web
  production build title; `expo export` and `expo-doctor` 21/21.
- **Left at the time**: the owner's manual checks, `pnpm db:reset`, the browser look, and the
  commit. The commit was made the same day (`1fd2988`); the owner accepted the report on
  2026-10-14; `db:reset` and a browser sign-in were reported done on 2026-10-17.

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
- **Review**: an independent reviewer pass returned "pass with fixes", no blockers, all fixed the
  same day (web without `NEXT_PUBLIC_API_URL`, Turbo pass-through variables, PostgreSQL on
  `127.0.0.1`, the shared `strict.json`, quieter `prisma generate`).
- **Left at the time**: five manual checks after a reboot. Three were done by the owner on
  2026-10-13 (PostgreSQL starts, `/health` 200, first commit); `db:migrate` ran in the Phase 2
  session; the browser check is still pending and the phone check moved to Phase 4.
