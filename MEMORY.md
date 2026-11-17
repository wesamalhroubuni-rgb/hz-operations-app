# MEMORY.md

Current state of the HZ project (repository folder `Operations_App`, packages `@ops/*`). Update this
file at the end of every session. Newest session log entry goes first. Last updated: 2026-11-17.

## Current phase

**Phases 1 to 7 are committed; Phase 8 (Hardening & release) has started.** On 2026-11-17 the
work of 2026-11-16 and of that day was committed in four commits (see the session log):
`644b773` (organization AI keys and models, live updates, themes, resolved alerts, the smart
capture format fix; **pushed**), `2131bdf` (redesign, prompt v3), `ffaa5d8` (Turkish and Arabic
in both apps), and `4fd59c7` (release readiness: `pnpm db:bootstrap`, EAS build profiles, release
guide). The last three are **local only** (`origin/main` is at `644b773`). All unit tests and all
1,724 integration tests pass. Phases are defined in [ROADMAP.md](ROADMAP.md).

**Real Claude was called for the first time on 2026-11-17** (as reported): smart capture with
`claude-opus-5-5` through an organization key pasted in Settings. The first call was refused (HTTP
400: 33 union-typed parameters in the structured-output schema, Anthropic allows 16); the answer
format now lists field values ([ADR-0014](docs/decisions/0014-smart-capture-answer-as-field-list.md)).
The English note polishing (prompt v3) was checked; Turkish and Arabic runs stopped at the
organization's own daily request limit (9, set in Settings). OpenAI speech-to-text and a real
daily summary have not been run.

**The app ran on a real phone for the first time on 2026-11-16** (Android, Expo Go 57.0.9 over USB
with `adb reverse`). The phone's 2026-11-17 redesign and languages **have not been seen on a
screen** (the phone was locked); the dashboard was checked with headless screenshots in light,
dark, and Arabic only. The combined manual test of Phases 4 to 7
([docs/reports/phase-7.md](docs/reports/phase-7.md)) is not recorded as done.

**The AI features are off until an admin turns them on** (Settings, AI). To use real AI an admin
pastes the organization's Claude key (and optionally an OpenAI key) in Settings, "Your AI keys"
(needs `AI_KEYS_ENCRYPTION_SECRET`, which the local `.env` has); the server keys in `.env` still
work too (README section 11). Without any key the API uses its fake providers in development.

**Open the dashboard on this PC at <http://127.0.0.1:3200>** (README section 3). Port 3000 is
used by another project, and another project (a Next.js app) listens on port 3001 on IPv6 (`::`),
so `localhost:3001` in a browser can reach it instead of this API. The local `.env` therefore has
`WEB_PORT=3200`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001`,
`CORS_ORIGINS=http://127.0.0.1:3200,http://localhost:3200`, and
`WEB_APP_URL=http://127.0.0.1:3200`. The dashboard runs as a production build
(`pnpm --filter @ops/web build`, then `pnpm --filter @ops/web start`), because the development
server lagged (Turbopack was watching `node_modules/.pnpm-task-run-state-v1`).

**The owner's local copy was lost and restored from GitHub on 2026-10-27** (folder
`Operations_App_restored`). The first Phase 5 attempt (after 2026-10-17) was never pushed and is
gone; Phase 5 was rebuilt on 2026-10-27. `.env` was recreated from `.env.example`.

**Phase 3 is accepted**: at the start of the Phase 4 session (2026-10-17) the owner reported that
`pnpm db:reset` ran, that sign-in works in the browser for `aylin` (admin), `selin` (supervisor),
and `deniz` (worker), and Phase 3 is committed as `8c8283a`.

**HZ** is the client's product name. Kaneri.ai builds and powers it. "Operations" remains the
technical name of the folder, the packages, the API domain folder, and the database.

## What exists

| Area              | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo          | pnpm 12 workspaces + Turborepo 2. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `format`, `format:check`, `db:up`, `db:down`, `db:logs`, `db:migrate`, `db:seed`, `db:bootstrap` (2026-11-17, ADR-0013), `db:reset`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Docker Compose    | PostgreSQL 17 and, since Phase 4, MinIO (`alpine/minio`, pinned by digest) for photos. `pnpm db:up` starts both; both bind to `127.0.0.1` by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/config` | Shared ESLint 10 flat config, Prettier config, three tsconfig presets. Unchanged since Phase 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/shared` | Zod schemas and endpoint functions for every resource, `/auth/*`, `/notifications`, `/sync/pull`, the Phase 6 dashboard routes, and since Phase 7 smart capture, summaries, anomalies, AI usage, `settings.ai` (with the model choices since 2026-11-16), the AI keys contract, and the per-capture output schema (field values as a list since 2026-11-17, ADR-0014); the offline headers and typed error codes; the transport (refresh once on a 401, per-call headers, text responses); `createAuthSessionManager` (with `refreshUser`); the sign-in wording in English and, since 2026-11-17, Turkish and Arabic (`AUTH_TRANSLATIONS`); the upload helper; custom-field forms; time-zone, CSV, and locale helpers; the translation core; dark and light design tokens with the brand-area tokens (`brandInk`, ...).                                                                                                           |
| `apps/api`        | NestJS 12 API, 80 paths. Platform: sign-in and sessions, the policy seam, idempotency, S3-compatible file storage, notifications, the outbox consumer, audit log, outbox, the AI platform (provider interfaces, Anthropic and OpenAI adapters, fakes, runner, traces, limits, prompt loader, and since 2026-11-16 the per-organization `AiProviderSelector` and `AiKeyChecker`), and `crypto/` (`SecretBox`). Domain: the access layer on every route, row versions and typed conflict codes, the attachment flow, notification rules, `GET /sync/pull`, the Phase 6 dashboard reads, smart capture, daily summaries, anomaly rules, AI usage, and the organization's AI keys (`/ai/keys`). Since 2026-11-17 the production bootstrap command (`pnpm db:bootstrap`, ADR-0013) and smart capture prompt v3.                                                                                                                        |
| `apps/web`        | Next.js 16.4.3 manager dashboard: `/login`, `/activate`, and behind sign-in Overview (with the daily summary and anomaly panels), Work logs (list, detail, report), Tasks (list and board, detail), Map, Summaries, People, Structure, Audit log, Settings (AI section with models, "Your AI keys", API status), AI usage; navigation by role; TanStack Query (live lists every 15 s) and Table, Leaflet, English, Turkish, and Arabic (right to left) chosen per browser (ADR-0015), times in the organization's time zone, theme System / Dark / Light in the account menu; since 2026-11-17 a black sidebar with icons, a split sign-in page, Inter and IBM Plex Sans Arabic. Checked only with headless screenshots (light, dark, Arabic, 2026-11-17); no person's browser session with data recorded.                                                                                                                        |
| `apps/mobile`     | Expo SDK 57 worker app: Home, Tasks, Task detail, New/Edit log (custom fields, photos, location), Logs, Log detail, Notifications, Profile, Sync, and Capture (Speak, Snap, Type a note) with the proposal reviewed in the New log form. Offline: per-user SQLite cache and write queue (smart captures queued too), photo and voice-note stores, sync engine (NetInfo, foreground, every 15 s while open, background task), sync indicator and screen, drafts. Light and dark (Profile → Theme: System / Dark / Light); the header sync indicator hides when everything is sent. Since 2026-11-17 English, Turkish, and Arabic (Profile → Language, ADR-0015) and the redesign (black brand headers, Home brand band, Quick capture tiles). First run on a real phone on 2026-11-16 (Expo Go); the 2026-11-17 changes not yet seen on a screen. `eas.json` has `development`, `preview`, and `production` profiles (none built). |
| Database          | PostgreSQL in Docker on `127.0.0.1` (port 5433 on this PC). `operations_app` was reset and has the seed and all nine migrations (2026-11-16). `operations_app_test` is rebuilt by the integration tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Docs              | `AGENTS.md`, this file, `ARCHITECTURE.md` (with the permissions matrix), `ROADMAP.md`, `README.md` (including the web dashboard, "Test on my phone", "Test offline mode in the Android emulator", and "AI features: keys, switches, and trying them" with "paste your own key"), ADR-0001 to ADR-0015, a `memory.md` in each app and package, the phase prompts in `docs/prompts/`, `docs/reports/phase-5.md`, `phase-6.md`, and `phase-7.md` (with the combined manual test of Phases 4 to 7), the Android release checklist and a privacy policy draft in `docs/release/` (2026-11-17), the logo files in `docs/brand/`.                                                                                                                                                                                                                                                                                                        |
| Subagents         | `reviewer`, `docs-keeper`, `test-writer` in `.claude/agents/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Not built yet: activation deep links into the app, photo upload from the browser (deferred to
Phase 8), Turkish and Arabic texts on the server (notifications, the summary template; prompts
reviewed with real samples), real email or SMS delivery of codes, encryption of the phone's local
database, a web button for generating summaries on demand, a production deployment, CI,
autonomous AI actions and questions over data (v2, out of scope). See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Signing in

- Users sign in with an email, phone number, or username plus a password (`POST /auth/login`,
  `client: 'web'` for cookies or `'mobile'` for bearer tokens).
- Demo users: identifiers per role are in README section 4. **Development passwords are defined
  only in the `DEV_PASSWORDS` constant in `apps/api/src/operations/seed/demo-seed.ts`**, one per
  role. Never copy them into a document, a log, a report, or a commit message; since 2026-11-16
  an agent may show them to the owner in chat when asked (AGENTS.md).
- A real deployment starts with no demo data: `pnpm db:bootstrap` creates the organization and
  its first administrator from the `BOOTSTRAP_*` variables (ADR-0013,
  [docs/release/android-release.md](docs/release/android-release.md)). Not run against any
  database yet; covered by `test/bootstrap.int-spec.ts`.
- New users get a one-time activation code from an admin (`POST /users`); in development the code
  and link are in the response and the API log. Reset codes: `POST /users/:id/password-reset`.
- The development database was reset with the current seed by 2026-11-16 (the seed failed on
  its backdated logs until `5038c71`). The seed has no photos, no notifications, and no
  `settings.ai` (every AI feature starts off).
- The dashboard is for supervisors, managers, and admins; a worker who signs in on the web sees
  "use the mobile app". Admins (`aylin`) manage people, the audit log, settings (including the AI
  switches), and see AI usage; managers (`murat`) see everything read-only in People;
  supervisors (`selin`, `emre`) see their scope. Daily summaries go by default to supervisors and
  managers (`selin`, `emre`, `murat`); `aylin` gets one only if an admin adds the admin role to
  the recipients.

## Verified

**On 2026-11-17**:

- `pnpm test` passes (re-run by the docs-keeper): 829 `@ops/shared` (18 files), 734 `@ops/api` (37
  suites), 210 `@ops/web` (16 files), 354 `@ops/mobile` (31 suites).
- As reported by the coordinator: `pnpm test:integration` all 1,724 tests in 30 suites pass (new:
  `bootstrap`, 5 tests); `pnpm lint`, `pnpm typecheck`, and `pnpm format:check` pass.
- As reported: a real smart capture with `claude-opus-5-5` and an organization key succeeded
  after the answer-format fix (ADR-0014), and the English polished note (prompt v3) was checked.
- As reported: the dashboard (production build) was checked with headless screenshots in light,
  dark, and Arabic. Nobody has looked at the phone's redesign.
- API paths counted from the controllers: still 80 (the bootstrap is a command, not a route).

**On 2026-11-16** (docs-keeper unless a line says otherwise):

- `pnpm test` passes with the uncommitted work: 815 `@ops/shared` (18 files), 734 `@ops/api` (37
  suites), 207 `@ops/web` (15 files), 351 `@ops/mobile` (30 suites, including the phone light
  mode).
- `pnpm test:integration`: all 1,719 tests in 29 suites pass (as reported by the coordinator,
  after the old expectations in `notifications.int-spec.ts` and `ai-off.int-spec.ts` were updated
  to the resolved-notification behaviour; new suites `ai-keys` and `notification-resolution`). A
  docs-keeper run before that update had 6 failures. `pnpm format:check` passes.
- API paths counted from the controllers: 80.
- The development database has all nine migrations (`prisma migrate status` showed eight;
  `20261116120000_notification_resolved_at` was then applied with
  `pnpm --filter @ops/api db:deploy`, as reported).
- As reported by the owner: the app ran on a real Android phone (Expo Go 57.0.9, USB with
  `adb reverse`) after the `5038c71` crash fix; the phone light mode was bundled and opened on
  the phone after an Expo restart, but nobody has looked at it on the screen yet.

**Phase 3 acceptance (owner, reported 2026-10-17)**: `pnpm db:reset` ran; sign-in works in a real
browser for `aylin`, `selin`, and `deniz`; Phase 3 committed (`8c8283a`). The rest of the Phase 3
manual list (Swagger per role, activation, lockout, sign-out everywhere) is not recorded as run.

**In the Phase 7 session (2026-10-30 to 2026-11-02)**, as reported by the coordinator unless a
line says otherwise. Everything below ran against the **fake** AI providers:

- Unit tests (re-run by the docs-keeper with `pnpm test` on 2026-11-02, all pass): 764
  `@ops/shared` (18 files), 706 `@ops/api` (35 suites), 191 `@ops/web` (12 files), 332
  `@ops/mobile` (28 suites).
- Integration tests: 1,681 in 26 suites plus 6 in `storage-minio` (27 suites in all; new:
  `ai-platform`, `smart-capture`, `smart-capture-safety`, `ai-summaries`, `ai-summaries-scope`,
  `ai-off`). Not re-run by the docs-keeper.
- `pnpm build` (the prompt files are in `apps/api/dist/operations/ai/prompts/`), `typecheck`,
  `lint`, `format:check`; `npx expo install --check` up to date.
- The test-writer's 46 tests found no bug: summaries hold only their recipient's scope (two
  supervisors, scope changes, flags), invalid model output, fake end-to-end, prompt injection in
  transcripts and task titles, narrative numbers equal the stats, switches and limits,
  offline-queued voice notes, the core with AI off.
- The reviewer's "pass with fixes", nothing blocking; the fixes are in the session log.

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

1. **The phone beyond a first start** (2026-11-16, Expo Go on Android): what was tried on it is
   not recorded. Not recorded: camera and gallery, location, all of Phase 5 on a device (SQLite,
   NetInfo, the background task, airplane mode, the conflict case), the Phase 7 capture
   (microphone, `expo-audio`, Snap, the review form), live updates, the light and dark
   themes, alerts disappearing once resolved, and everything of 2026-11-17: the redesign (brand
   band, Quick capture tiles, black headers, sign-in hero), the Language choice, Turkish, and
   Arabic right to left after a restart. The emulator `hz_pixel` (README section 6) is still
   unused.
2. **The web dashboard in a real browser by a person** with the seed data (including the AI keys
   card, the model pickers, live refresh, the theme and language choices, Turkish and Arabic), as
   `aylin` (admin), `selin` (supervisor), and `murat` (manager): the manual list in
   `docs/reports/phase-7.md` (which includes the Phase 6 list), phone and desktop widths, keyboard
   use, print preview of the report, a CSV opened in Excel, the map tiles, and the Phase 7 summary
   panels, Summaries, the AI settings, and AI usage. Only headless screenshots exist (2026-11-17).
3. **Real AI beyond one English capture** (2026-11-17): the photo input (Snap), a summary
   narrative, the refusal fallback beta (`AI_ANTHROPIC_REFUSAL_FALLBACK`), OpenAI transcribing the
   phone's m4a, Turkish and Arabic captures (the "never translate" rule of prompt v3), and the
   quality of proposals and narratives. The summary and notification texts exist in English only.
4. **A development or release build**: configured (`expo-dev-client`, `apps/mobile/eas.json`
   profiles `development`, `preview`, `production`), never built or installed. It needs the
   owner's Expo account and `eas init`. Push and background sync need it. `expo-doctor` has not
   been re-run since `expo-audio` was added.
5. **`pnpm db:bootstrap` against a real database** (only the integration suite has run it).
6. **Real push delivery through Expo** (only a fake Expo client in tests).
7. **AWS S3 or any provider other than MinIO.**
8. The web "API status" card's automatic recovery, watched by a person (the card is on the
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
- **The development database `operations_app` was reset by 2026-11-16** (the stray Phase 5
  migration is gone) and has all nine migrations (the last one applied with
  `pnpm --filter @ops/api db:deploy` on 2026-11-16). The test database is rebuilt by the
  integration tests.
- **Port 3000 on this PC is taken** by another project, and **port 3001 on IPv6 (`::`)** by
  another project's Next.js app (seen on 2026-11-17), so `http://localhost:3001` in a browser may
  not reach this API (which listens on `127.0.0.1:3001`). Since 2026-11-17 the local `.env` uses
  `WEB_PORT=3200`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001`,
  `CORS_ORIGINS=http://127.0.0.1:3200,http://localhost:3200`, and
  `WEB_APP_URL=http://127.0.0.1:3200`; open the dashboard at <http://127.0.0.1:3200>. It runs as a
  production build (`pnpm --filter @ops/web build`, then `start`): the development server lagged
  because Turbopack watched `node_modules/.pnpm-task-run-state-v1`. Rebuild after any web change
  or any `NEXT_PUBLIC_*` change.
- Android SDK under `%LOCALAPPDATA%\Android\Sdk` with the emulator and `adb`; the virtual device
  `hz_pixel` (Android 35, Google APIs, x86_64) exists. `ANDROID_HOME` is not set system-wide
  (README section 6 sets it in the Expo terminal). Never started for this project yet.
- A real phone (Android, Tecno Spark 30C) is used over USB with `adb reverse`; Expo Go 57.0.9 is
  sideloaded on it because the Play Store offers the SDK 58 client. **On the night of 2026-11-16
  to 2026-11-17 the Play Store auto-updated Expo Go to SDK 58**, which cannot open this project;
  57.0.9 was reinstalled from the APK of Expo's GitHub release. The owner should turn off
  automatic updates for Expo Go in the Play Store.
- Branch `main`, 13 commits up to `4fd59c7` (2026-11-17); `origin/main` (private GitHub
  repository `wesamalhroubuni-rgb/hz-operations-app`) is at `644b773`, so `2131bdf`, `ffaa5d8`, and
  `4fd59c7` are not pushed. The working tree was clean at the start of the docs-keeper run.
- The local `.env` (git-ignored) was recreated from `.env.example` on 2026-10-27. On 2026-11-17
  it sets `AI_KEYS_ENCRYPTION_SECRET`, the dashboard values above, `API_HOST=127.0.0.1`, and
  `EXPO_PUBLIC_API_URL=http://localhost:3001` (the phone uses `adb reverse`), and has no
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (the Claude key was pasted in the dashboard).
  `EXPO_PUBLIC_EAS_PROJECT_ID` is empty until the owner runs `eas init`.
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
  by key. The push shows generic text.
- **Languages (ADR-0015, 2026-11-17)**: both apps have English, Turkish, and Arabic, chosen per
  browser or phone, independent of `User.locale` (which still picks the notification and summary
  language). No native speaker has reviewed the Turkish and Arabic texts. On the phone a switch to
  or from Arabic changes the layout direction only after the app is reopened. The browser-tab
  titles stay English. The web renders nothing on the server (`LanguageGate`), so a page is blank
  until its script runs.
- **Dashboard (ADR-0009)**: photos cannot be uploaded from the browser (deferred to Phase 8: a
  CORS rule on the bucket). The directory is capped at 5,000 entries per kind; exports are
  synchronous and capped at 10,000 rows (422 `export_too_large`); the report covers at most 92
  days; overview aggregates are computed on read. The API accepts a changed log-type field key;
  only the editor prevents it. Log types cannot be restored once archived. Requiring a site or
  team for worker and supervisor memberships is a dashboard rule only. The map uses the public
  OpenStreetMap tiles unless `NEXT_PUBLIC_MAP_TILE_URL` is set (their usage policy forbids heavy
  use). The CSP still has no `img-src` / `connect-src`.
- **AI layer (ADR-0010, ADR-0011, ADR-0014)**: the real Claude has answered smart capture in
  English only (2026-11-17); the proposed text is a polished rewrite of the worker's words (the
  worker reviews it). Usage limits count per UTC day,
  not the organization's day; the per-user AI rate limit and the scheduler's 15-minute back-off
  are in memory per process. A model missing from `ai-prices.ts` counts $0 against the cost
  limit. Anomaly parameters are counted over the organization's data (a reader may see a count
  including records outside their scope; accepted for v1). Flags are computed once a day at
  summary time, thresholds are constants. A missed summary run is caught up the same local day
  only; older days need the admin route (up to 7 days back), which has no web button. Snap
  photos are uploaded twice when also attached to the log. The prompts, the summary template,
  and the notification texts are English only (per-key fallback). `POST /ai/capture/:id/process`
  and `/upload-url` are not `@Idempotent()` (idempotent by state; accepted). The summary
  generate route runs actor-less (audit actor `system`, the admin in `metadata.requestedById`).
  Provider data agreements and zero data retention are not arranged (Phase 8). **Organization
  keys (ADR-0012)**: the key-check limit (5 per admin per minute) is in memory; a model changed
  after a key was saved is not re-checked; changing `AI_KEYS_ENCRYPTION_SECRET` makes stored keys
  unreadable (no rotation).
- **Resolved notifications** (2026-11-16): resolution runs in the outbox consumer, so an alert
  disappears up to a poll (and, on the phone, a sync) after the change; rows are kept as history
  with no retention rule.
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
- Expo Go shows its own icon and splash and ignores the config plugins. The Play Store updates
  Expo Go to the SDK 58 client unless automatic updates are off for it (2026-11-17).
- On this PC the web development server lags (Turbopack watching
  `node_modules/.pnpm-task-run-state-v1`); the dashboard is run as a production build instead,
  which must be rebuilt after every web or `NEXT_PUBLIC_*` change.
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

- Before the first store build: the final mobile bundle identifiers, which Expo account owns the
  EAS project, the Play Console account, the production domains, and the slug of the real
  organization (`docs/release/android-release.md` section 1); the bracketed parts of the privacy
  policy draft.
- With the owner (ADR-0008): is the 30-day kept-queue period right, and should the phone's local
  database be encrypted (SQLCipher) before production?
- Which deep-link scheme or universal link should activation links use, so they open the app, and
  in which phase?
- Who reviews the Turkish and Arabic catalogues of both apps (written on 2026-11-17), and who
  writes the server's notification and summary texts in those languages? Should the device's
  language choice be written back to `User.locale` (ADR-0015)?
- Before production: which map tile provider (`NEXT_PUBLIC_MAP_TILE_URL`)?
- Before production: which object storage provider and region, what retention for photos, and
  who may erase them? Which email or SMS provider delivers one-time codes? Who in the client's
  organization holds the admin role?
- Before production: is the lockout acceptable as is (F4)? Should 403 and 404 answers be audited?
- With the owner (Phase 7): which Claude model in production (since 2026-11-16 an admin picks it
  per organization; the server default is `claude-opus-5-5`), what daily cost ceiling per
  organization, and does the client need data
  residency (which would point to self-hosted speech-to-text, ADR-0010 alternatives)? Who reviews
  the prompts with real Turkish and Arabic voice notes?
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

Answered in Phase 7 (see [ADR-0010](docs/decisions/0010-ai-layer-architecture.md) and
[ADR-0011](docs/decisions/0011-daily-summaries-and-anomaly-rules.md)): the AI providers
(Anthropic Claude for proposals and narratives, OpenAI `gpt-4o-transcribe` for speech-to-text,
both optional behind interfaces with fakes), what is sent to them and what never is, retention
of AI data, cost controls (organization switches, daily request and cost limits, per-user rate
limit, timeouts), and how summaries stay within the recipient's scope (`runAsUser`).

## Session log

### 2026-11-17: commits, first real Claude call, redesign, Turkish and Arabic, release readiness

- **What changed** (four commits; only the first is pushed)
  - `644b773`: the work of 2026-11-16 (organization AI keys and models, live updates, themes,
    resolved notifications) plus the smart capture format fix. The first real Claude call
    (`claude-opus-5-5`, organization key) was refused with HTTP 400: the structured-output schema
    had 33 union-typed parameters, Anthropic allows 16. `buildCaptureOutputSchema` now answers
    `logTypeKey` and a list `fields: [{ field: '<logType>.<field>', value, confidence }]` with
    non-null confidences, at most six unions whatever is offered (a test in
    `ai-contracts.test.ts` holds it); prompt `smart-capture-extract` v2
    ([ADR-0014](docs/decisions/0014-smart-capture-answer-as-field-list.md)).
  - `2131bdf`: prompt v3 (the proposed text is the worker's note polished in the worker's own
    language, never translated). Brand tokens `brandInk`, `onBrandInk`, `onBrandInkMuted`,
    `brandInkRaised` (the logo's black in both themes, AA-checked). Phone: black brand headers and
    a status bar with light icons in both themes, Home brand band (`BrandBand.tsx`), Quick capture card with tiles,
    `SectionHeader.tsx`, a calendar icon in the date field, a Profile avatar header, a black
    loading screen, a sign-in hero; `BrandHeader.tsx` deleted. Dashboard: black dotted sidebar
    with icons (`components/ui/icons.tsx`), the organization name beside the logo, the logo
    blended with `mix-blend-mode: lighten`, a split sign-in page, Inter (and later IBM Plex Sans
    Arabic) through `next/font`, shadows, tinted badges, wider date filters. "Powered by
    Kaneri.ai" removed from both apps (the web brand test now checks the brand names no builder).
  - `ffaa5d8`: Turkish and Arabic catalogues in both apps and `AUTH_TRANSLATIONS` in
    `@ops/shared`; the language is chosen per browser (`hz.language`, account menu, pills on the
    sign-in page, `LanguageGate`) and per phone (`ops.language`, Profile → Language,
    `LanguageProvider`); Arabic right to left with Latin digits
    ([ADR-0015](docs/decisions/0015-interface-language-per-device.md)).
  - `4fd59c7`: `pnpm db:bootstrap` with `AuthAdminService.setFirstPassword`,
    `UsersService.createWithFirstPassword`, the `BOOTSTRAP_*` variables in `.env.example`, and
    `test/bootstrap.int-spec.ts` ([ADR-0013](docs/decisions/0013-production-bootstrap.md));
    `apps/mobile/eas.json` profiles `preview` (APK) and `production` (app bundle,
    `autoIncrement`, `appVersionSource: remote`, submit to the internal track as a draft);
    `docs/release/android-release.md` and `docs/release/privacy-policy.md`.
  - Local environment (not committed): the dashboard on `127.0.0.1:3200` as a production build
    (see "Machine and repository state"); Expo Go reinstalled at 57.0.9 after a Play Store
    auto-update to SDK 58.
  - Docs (docs-keeper): ADR-0014 and ADR-0015 written; ADR-0009 and ADR-0010 marked as amended in
    part; MEMORY, AGENTS, ARCHITECTURE, ROADMAP, README (bootstrap, release guide, opening the
    dashboard), and the folder `memory.md` files of `apps/api`, `apps/web`, `apps/mobile`, and
    `packages/shared`.
- **Why**: the owner wants to use real AI, a cleaner branded look, the apps in Turkish and Arabic,
  and a path to a Play Store release with no demo data.
- **Verified**: see "Verified" (2026-11-17): unit tests re-run by the docs-keeper; integration
  (1,724 in 30 suites), lint, typecheck, and format check as reported; one real English capture;
  headless screenshots of the dashboard.
- **Left to do**
  - Push `2131bdf`, `ffaa5d8`, and `4fd59c7`.
  - Owner: look at the phone (redesign, languages, Arabic after a restart); turn off Play Store
    auto-update for Expo Go; raise the organization's daily request limit and try Turkish and
    Arabic captures, a voice note (needs an OpenAI key), a photo capture, and a summary; the
    combined manual test (`docs/reports/phase-7.md`).
  - Owner, for the release: the decisions and accounts in `docs/release/android-release.md`.
  - Phase 8: the remaining "done when" items in ROADMAP.md.

### 2026-11-16: first phone run, organization AI keys, live updates, themes, resolved alerts

- **Committed** (`5038c71`, pushed): the seed creates logs older than the 7-day backdate limit
  at the oldest accepted moment and then writes their real `occurredAt` (before, `pnpm db:reset`
  failed in the seed); the mobile app no longer loads `expo-notifications` in Android Expo Go
  (`src/push/notificationsModule.ts`), which lacks `ExpoTopicSubscriptionModule` and crashed the
  app at start on the first real phone; AGENTS.md lets agents show the seed's `DEV_PASSWORDS` to
  the owner in chat when asked (never in a log, document, report, or commit).
- **First real-phone run**: Tecno Spark 30C (Android) over USB with `adb reverse`, Expo Go
  57.0.9 sideloaded because the Play Store has the SDK 58 build. The development database had been
  reset before it.
- **Written on 2026-11-16, committed on 2026-11-17 in `644b773`**:
  - Organization AI keys and model choice
    ([ADR-0012](docs/decisions/0012-organization-ai-provider-keys.md)): migration
    `20261116090000_ai_provider_keys` (`AiProviderKey`, enum `AiKeyProvider`); `SecretBox`
    (`src/platform/crypto`); `AiProviderSelector`, `AiKeyChecker`, `AI_REAL_PROVIDER_FACTORIES`,
    `AI_ORGANIZATION_KEYS` (platform); `src/operations/ai/keys/` with `GET /ai/keys`,
    `PUT` / `DELETE /ai/keys/:provider` (policy `ai_key.manage`, admins; 5 checks per admin per
    minute; codes `ai_key_invalid` 422 and `ai_key_storage_unavailable` 503); `settings.ai.llmModel`
    and `sttModel`; price row `claude-fable-5-2`; env `AI_KEYS_ENCRYPTION_SECRET`; web "Your AI
    keys" card and model pickers. 80 paths.
  - Live updates: `refreshUser` in the shared session manager; the phone syncs every 15 s in the
    foreground (backoff to 5 minutes), `subscribePulls` / `scopeChanged`, `useLiveUser`,
    `useServerRefresh` (pull to refresh syncs); web `liveRefetchInterval` (15 s for live lists
    while visible) and a user re-check every 30 s.
  - Themes: `lightTheme` and `themeForScheme` in `@ops/shared`; the dashboard follows the system
    or a manual Theme: System / Dark / Light in the account menu (`src/lib/theme.ts`,
    `localStorage`, inline init script, `data-theme`). The phone (another agent) follows the system
    or Profile → Theme: System / Dark / Light (`apps/mobile/src/theme/`,
    `userInterfaceStyle: 'automatic'` in `app.config.ts`), and the header sync indicator hides
    when everything is sent. Bundled and opened on the phone after an Expo restart; nobody has
    looked at it on the screen yet.
  - Resolved notifications: migration `20261116120000_notification_resolved_at`,
    `NotificationService.resolve`, `notification-resolution.service.ts`; resolved rows leave the
    inbox, the unread count, and the sync pull.
  - The product name is no longer written next to the logo (mobile `BrandHeader`, web
    `AuthShell` and sidebar).
  - Docs (docs-keeper): ADR-0012 completed (model choice, rate limit, `unreadable`, the `model`
    error detail); ARCHITECTURE, AGENTS, README (section 11 "paste your own key" with models and
    the `AI_PROVIDER=fake` note, section 9, section 5 phone notes, update steps), ROADMAP,
    and the folder `memory.md` files.
- **Why**: the owner wants to switch to real AI from the dashboard with the organization's own
  key and choose the model, see changes without reloading, a light theme, and fewer stale alerts.
- **Verified**: see "Verified" (2026-11-16): unit tests and all 1,719 integration tests pass
  (after the old notification expectations in `notifications` and `ai-off` were updated);
  `format:check` passes; both new migrations applied to the development database.
- **Left to do**
  - Review and commit the work of 2026-11-16 (done on 2026-11-17, `644b773`).
  - Owner: look at the phone and the dashboard in light and dark mode; paste a real Claude key in
    "Your AI keys" and try a capture and a summary (a capture done on 2026-11-17); the combined
    manual test (`docs/reports/phase-7.md`).
  - Planned: the rest of the phone redesign, Turkish and Arabic (both done on 2026-11-17).

### 2026-10-30 to 2026-11-02: Phase 7 intelligent layer v1 (smart capture, daily AI summaries)

- **What changed**
  - Database: migration `20261030090000_phase7_ai`. Tables `SmartCapture`, `DailySummary`
    (unique per organization, recipient, day), `AnomalyFlag` (unique fingerprint), and the
    platform table `AiTrace`; seven enums; `WorkLogSource.ai` renamed in place to `ai_assisted`;
    `SmartCapture.workLogId` unique with a foreign key to `WorkLog` (`ON DELETE RESTRICT`).
    `organization.settings.ai` (switches, summary time, recipient roles, limits), all off by
    default.
  - API platform: `src/platform/ai/` (provider interfaces and registry, Anthropic adapter on
    `@anthropic-ai/sdk` pinned exactly `1.3.0`, OpenAI speech-to-text over `fetch`, deterministic
    fakes steered by `FAKE-*` markers, `AiRunnerService`, `AiTraceService`, `AiUsageLimiter`,
    price table, `FilePromptLoader`, `untrustedDataBlock`, `AiModule.register`).
  - API domain: `src/operations/ai/` (`OperationsAiModule`, `GET /ai/usage`, smart capture with
    six routes and an hourly retention job, the confirm path inside `POST /work-logs`, daily
    summaries with a scheduler and the admin generate route, anomaly rules, the outbox handler
    sending `ai.daily_summary`, two versioned prompt files copied by `nest-cli.json` assets and
    `apps/api/scripts/copy-prompts.mjs`); `AccessService.runAsUser`; five policies; error codes
    `ai_disabled`, `ai_limit_reached`, `ai_unavailable`; 78 paths.
  - `@ops/shared`: `domain/ai-capture.ts`, `ai-capture-output.ts`, `ai-settings.ts`,
    `ai-summaries.ts`, `platform/ai.ts`; `source` / `aiProposalId` / `aiMetadata` on work logs;
    `aiFeatures` on the organization summary; client groups `smartCapture`, `aiSummaries`,
    `aiUsage`.
  - Mobile: `expo-audio ~57.0.5` and its config plugin (microphone text, no background
    recording); `CaptureScreen` (Speak, Snap, Type a note), the review in the New log form, queue
    kinds `smartCapture` and `discardSmartCapture`, `offline-audio/<userId>/`, SQLite table
    `smart_captures` (migration 2), unreviewed captures counted at sign-out.
  - Web: Overview summary and anomaly panels, `/summaries`, `/ai-usage`, the AI section on
    Settings, capabilities `readSummaries` and `viewAiUsage`.
  - Configuration: the optional `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `AI_*` variables in
    `.env.example`, `apps/api/src/config/env.ts`, and `turbo.json`.
  - Docs: ADR-0010 and ADR-0011 (accepted, written in the contracts step on 2026-10-30, notes
    added after the review); every document updated; README section 11 (keys, switches, fakes,
    microphone); `docs/reports/phase-7.md` with the combined manual test of Phases 4 to 7.
- **Why**: Phase 7 of the roadmap (`docs/prompts/phase-7.md`): faster, richer logging for workers
  and an end-of-day picture for supervisors and managers, without making the core less reliable
  or leaking data across scopes.
- **How it was built**: a contracts step (2026-10-30: ADRs, shared contracts, migration,
  `runAsUser`, policies, environment, error codes), then three parallel agents: A (AI platform),
  B (smart capture, API and mobile), C (summaries, anomalies, dashboard, notifications); then the
  `test-writer`, the `reviewer`, and the `docs-keeper`.
  - The test-writer added 46 tests and found no bug.
  - The reviewer returned "pass with fixes", nothing blocking. Fixed: (1) the generate route's
    default day is the last due day, and today before the summary time is refused (422); (2)
    overdue counts use `min(now, end of day)`; (3) the phone's sign-out counts unreviewed
    captures; (4) `AI_ANTHROPIC_REFUSAL_FALLBACK` (default false), provider answers 400, 401, 403,
    404, 422 become `rejected` (capture `failed` with `provider_rejected`), an unpriced answering
    model is costed at the configured model's price; (5) the fake LLM answers null for nullable
    values; (6) a 15-minute back-off per organization and day in the scheduler; (7) the
    `SmartCapture.workLogId` foreign key; (8) ADR notes (anomaly parameters counted over the
    organization's data: accepted). Accepted as is: the generate route runs actor-less (audit
    actor `system`, `metadata.requestedById`); `process` and `upload-url` are not
    `@Idempotent()`.
- **Verified**: see "Verified" above (unit counts re-run by the docs-keeper on 2026-11-02;
  integration 1,681 in 26 suites plus 6 in `storage-minio`, build, lint, typecheck, format check,
  and `npx expo install --check` as reported). All with the fake providers.
- **Left to do**
  - Owner: `pnpm db:reset`; the combined manual test of Phases 4 to 7
    (`docs/reports/phase-7.md`) on a free `WEB_PORT`, in the emulator `hz_pixel` or on the phone;
    obtain `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, put them in the root `.env`, restart the API,
    and repeat the capture and summary steps with real providers; then decide on
    `AI_ANTHROPIC_REFUSAL_FALLBACK`.
  - Coordinator: commit "Phase 7: ..." and push.
  - Later: Turkish and Arabic prompts and catalogues reviewed with real samples; provider data
    agreements and zero retention, a shared store for the AI rate limit (Phase 8); a web button
    for generating summaries if wanted.

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
  - Coordinator: commit "Phase 6: ..." and push (done: `713f592`).
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
