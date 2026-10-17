# MEMORY.md

Current state of the HZ project (repository folder `Operations_App`, packages `@ops/*`). Update this
file at the end of every session. Newest session log entry goes first. Last updated: 2026-10-17.

## Current phase

**Phase 4 (Mobile worker app): code complete, pending the owner's phone test, a final `pnpm dev`
check, and commit.** Nothing from Phase 4 is committed. `main` has Phase 1 (`d03c843`), Phase 2
(`1fd2988`), and Phase 3 (`8c8283a`). **Phase 5 (Offline mode & sync) is next.** Phases are
defined in [ROADMAP.md](ROADMAP.md).

**Phase 3 is accepted**: at the start of the Phase 4 session (2026-10-17) the owner reported that
`pnpm db:reset` ran, that sign-in works in the browser for `aylin` (admin), `selin` (supervisor),
and `deniz` (worker), and Phase 3 is committed as `8c8283a`.

**HZ** is the client's product name. Kaneri.ai builds and powers it. "Operations" remains the
technical name of the folder, the packages, the API domain folder, and the database.

## What exists

| Area              | State                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo          | pnpm 12 workspaces + Turborepo 2. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `format`, `format:check`, `db:up`, `db:down`, `db:logs`, `db:migrate`, `db:seed`, `db:reset`.                                                                                                                            |
| Docker Compose    | PostgreSQL 17 and, since Phase 4, MinIO (`alpine/minio`, pinned by digest) for photos. `pnpm db:up` starts both; both bind to `127.0.0.1` by default.                                                                                                                                                                                     |
| `packages/config` | Shared ESLint 10 flat config, Prettier config, three tsconfig presets. Unchanged since Phase 1.                                                                                                                                                                                                                                           |
| `packages/shared` | Zod schemas and endpoint functions for every resource, `/auth/*`, and `/notifications`; the transport (refresh once on a 401); `createAuthSessionManager`; the attachment upload helper (`uploadAttachment`, resumable); custom-field form logic; custom-field validation; design tokens.                                                 |
| `apps/api`        | NestJS 12 API, 56 paths. Platform: sign-in and sessions, the policy seam, S3-compatible file storage with image verification, notifications (in-app list, channels, Expo push, push tokens), the outbox consumer, audit log, outbox. Domain: the access layer on every route, the attachment upload flow and cleanup, notification rules. |
| `apps/web`        | Next.js 16.4: `/login`, `/activate`, and a protected `/` (name, role, organization, sign-out, API status card). Unchanged in Phase 4.                                                                                                                                                                                                     |
| `apps/mobile`     | Expo SDK 57 worker app: React Navigation, Home, Tasks, Task detail, New/Edit log (custom fields, photos, location), Logs, Log detail, Notifications, Profile; TanStack Query reads, one repository layer for writes, a persisted photo upload queue, drafts, i18n, push. Development build configured (`eas.json`). Never run on a phone. |
| Database          | PostgreSQL in Docker on `127.0.0.1`. Four migrations applied to `operations_app` (the fourth, `20261017090000_phase4_mobile`, on 2026-10-17). It holds the Phase 3 seed from the owner's `pnpm db:reset`. `operations_app_test` is created by the integration tests.                                                                      |
| Docs              | `AGENTS.md`, this file, `ARCHITECTURE.md` (with the permissions matrix), `ROADMAP.md`, `README.md` (including "Test on my phone"), ADR-0001 to ADR-0007, a `memory.md` in each app and package, the owner's phase prompts in `docs/prompts/`, the logo files in `docs/brand/`.                                                            |
| Subagents         | `reviewer`, `docs-keeper`, `test-writer` in `.claude/agents/`.                                                                                                                                                                                                                                                                            |

Not built yet: offline storage and sync (Phase 5), activation deep links into the app, the
signed-in state when the server is unreachable at start, any web feature screen (Phase 6), real
email or SMS delivery of codes, and the AI layer. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Signing in

- Users sign in with an email, phone number, or username plus a password (`POST /auth/login`,
  `client: 'web'` for cookies or `'mobile'` for bearer tokens).
- Demo users: identifiers per role are in README section 4. **Development passwords are defined
  only in the `DEV_PASSWORDS` constant in `apps/api/src/operations/seed/demo-seed.ts`**, one per
  role. Never copy them into a document, a log, or chat output.
- New users get a one-time activation code from an admin (`POST /users`); in development the code
  and link are in the response and the API log. Reset codes: `POST /users/:id/password-reset`.
- The development database has the Phase 3 seed (the owner ran `pnpm db:reset` before
  2026-10-17), so every demo user can sign in. The seed has no photos and no notifications.

## Verified

**Phase 3 acceptance (owner, reported 2026-10-17)**: `pnpm db:reset` ran; sign-in works in a real
browser for `aylin`, `selin`, and `deniz`; Phase 3 committed (`8c8283a`). The rest of the Phase 3
manual list (Swagger per role, activation, lockout, sign-out everywhere) is not recorded as run.

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

1. **Anything on a phone**: the screens, camera and gallery, location, SecureStore, the upload
   queue, push. The owner will test over the phone's hotspot (README section 5).
2. **A development build**: configured (`expo-dev-client`, `apps/mobile/eas.json`), never built
   or installed. It needs the owner's Expo account and `eas init`.
3. **Real push delivery through Expo** (only a fake Expo client in tests).
4. **AWS S3 or any provider other than MinIO.**
5. **The full `pnpm dev` with MinIO and the web app in a browser after Phase 4** (the coordinator's
   final check).
6. The web status card's automatic recovery, watched by a person (unit tested).

## Machine and repository state

- Node 24.20.0, pnpm 12.11.2, Git 2.55, Docker Desktop with the WSL 2 backend. Windows long paths
  enabled.
- Containers `operations-app-postgres-1` and `operations-app-minio-1` run (both healthy on
  2026-10-17). Docker Desktop stopped on its own once on 2026-10-13 (cause unknown).
- Branch `main`, three commits. All Phase 4 work is uncommitted in the working tree, including the
  untracked `docs/prompts/phase-4.md`, the new migration, and the new ADRs.
- The local `.env` (git-ignored) has every key of `.env.example`, including the Phase 4 storage,
  notification, MinIO, and mobile variables (checked by key name only on 2026-10-17).
  `EXPO_PUBLIC_EAS_PROJECT_ID` is empty until the owner runs `eas init`.
- User ids are generated, so they change on every reset. Sign in with identifiers instead.

## Known limitations

Security (accepted for now; see ADR-0004 to ADR-0007)

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
- **A lost `startUpload` answer** can leave a second pending attachment (visible only to the
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

- **An author cannot complete a photo upload after the edit window closed** (the same rule as
  starting it). Accepted.
- **Notification text is English only**, rendered on the server; the push shows generic text.
- Redaction in audit and outbox events is by key name at any depth.
- Old log type definitions are not kept; `logTypeVersion` resolves only through the audit log.
- No optimistic locking or row version: concurrent updates are last-write-wins.
- Outbox sequence numbers are assigned at insert; the consumer's 60-second settle rule covers
  late commits, and it re-reads that window on every poll.
- Scope resolution reads every membership, site, and team of the organization once per request.
- Only users, sites, and teams can be restored.
- Every authenticated request reads the session and the user from the database.
- `/health` logs an error on every call while the database is down.

Clients and tooling

- The mobile app is online only (Phase 5). When the server is unreachable at start it shows the
  sign-in screen with a notice and keeps the tokens.
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
- Phase 5: which local database, and what is the conflict rule? Does the server need a row
  version? How long may the app stay signed in offline, and what does it show when the session
  turns out to be revoked on reconnect?
- Which deep-link scheme or universal link should activation links use, so they open the app, and
  in which phase?
- Phase 6: which admin screens are needed for users, memberships, codes, and sessions? Where is a
  user's language stored, for localised notifications?
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

## Session log

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
