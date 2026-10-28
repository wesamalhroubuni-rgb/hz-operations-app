# ROADMAP.md

Eight phases for HZ. A phase is done only when every "done when" item is verified, not merely
written. Tick an item when it has been checked and note the date in [MEMORY.md](MEMORY.md).
Criteria for Phases 3 to 8 are the current plan and should be refined at the start of each phase.

| Phase | Name                         | Status                                                                    |
| ----- | ---------------------------- | ------------------------------------------------------------------------- |
| 1     | Setup & architecture         | Done except two checks: one pending, one waiting for the phone test       |
| 2     | Backend core                 | Accepted and committed (`1fd2988`); one check waits for a phone build     |
| 3     | Authentication & permissions | Accepted and committed (`8c8283a`); device checks wait for the phone test |
| 4     | Mobile worker app            | Committed (`280c50a`); phone test and development build open              |
| 5     | Offline mode & sync          | Code complete and tested; emulator and phone test open                    |
| 6     | Web manager dashboard        | Next                                                                      |
| 7     | Intelligent layer v1         | Planned                                                                   |
| 8     | Hardening & release          | Planned                                                                   |

## Phase 1: Setup & architecture

**Goals**: a working monorepo in which the API, web app, and mobile app all run, share code, and
are documented well enough for a new developer or AI session to continue.

**Done when**

- [x] pnpm workspace and Turborepo run `build`, `lint`, `typecheck`, and `test` across all packages
      from the root, and `pnpm install` and `pnpm format:check` pass (verified 2026-10-12).
- [x] `packages/config` provides the shared ESLint, Prettier, and TypeScript settings.
- [x] `packages/shared` exports a Zod schema used by the API, web, and mobile apps.
- [x] The API validates its environment at boot and stays up when the database is down:
      `GET /health` returns 503 with `database: 'down'` (verified 2026-10-12).
- [x] The web dev server serves the placeholder page on port 3000 (verified 2026-10-12).
- [x] The mobile app bundles: Metro dev server runs, `expo export` succeeds for Android and iOS,
      `expo-doctor` passes 21/21 (verified 2026-10-12).
- [x] `.env.example` exists, is not git-ignored, and lists every variable the apps read.
- [x] Documentation system written: `AGENTS.md`, `MEMORY.md`, `ARCHITECTURE.md`, `ROADMAP.md`,
      `README.md`, ADR-0001, and a `memory.md` per app and package.
- [x] The PostgreSQL container starts with `pnpm db:up` (verified by the owner, 2026-10-13).
- [x] `GET /health` returns 200 with `database: 'up'` (verified by the owner, 2026-10-13).
- [x] `pnpm --filter @ops/api db:migrate` runs against the database (both Phase 2 migrations were
      applied to the development database on 2026-10-13).
- [ ] The web "API status" card shows the correct state in a real browser. On 2026-10-13 the owner
      saw "API unreachable" on first load while the API was still compiling. Phase 2 added
      automatic retries (2, 4, 8, 16 seconds) and a "Check again" button; that recovery is unit
      tested but has not been watched in a real browser.
- [ ] The mobile app opens on a real phone in Expo Go and reaches the API. Part of the Phase 4
      phone test (the campus Wi-Fi blocks phone-to-PC traffic; the owner will use the phone's
      hotspot). The Phase 1 "API reachable" card was replaced by the worker screens in Phase 4.
- [x] Independent `reviewer` pass completed and its should-fix findings resolved (2026-10-12).
- [x] Git identity configured and the first commit made (commit `d03c843` on `main`, verified by
      the owner, 2026-10-13).

## Phase 2: Backend core (organization model, work data, audit log, outbox, branding)

**Goals**: the flexible organization model, the work data, a REST API over them, an audit log and
an event outbox from the start, and HZ branding in both clients. No AI. Authentication and
permission enforcement came in Phase 3; during Phase 2 the API was protected only by a
development-only header (removed in Phase 3).

The criteria below were rewritten on 2026-10-13 to match the owner's Phase 2 prompt
(`docs/prompts/phase-2.md`). One earlier criterion, "a local development implementation" of photo
storage, moved to Phase 4: the prompt asks for a storage interface only. On 2026-10-14 the owner
reviewed the Phase 2 report and asked to proceed to Phase 3; that acceptance is the record for
the items ticked "accepted" below. Items that were never actually checked stay open.

**Done when**

Data and decisions

- [x] The open questions on scope and tenancy are answered in
      [ADR-0002](docs/decisions/0002-flexible-organization-and-scope-model.md): scope is by site
      and team, both optional, through memberships; the model is multi-tenant-ready with one
      organization per user.
- [x] [ADR-0003](docs/decisions/0003-configurable-log-types-with-custom-fields.md) records the
      custom-field design and its tradeoffs.
- [x] Prisma models, indexes, foreign keys, and migrations exist for organization, users, sites,
      teams, memberships with site and team scope, log types, tasks with assignees, work logs,
      attachments, audit events, and outbox events. Users, sites, and teams (and the other
      business records) are archived, not deleted. Both migrations are applied to the development
      database (2026-10-13).
- [x] Sites and teams have an optional `parentId`; cycles are rejected.
- [x] Work logs carry `occurredAt` separately from `createdAt`, optional GPS, a status, a
      client-generated id that makes creation idempotent, and nullable `source` / `aiMetadata`
      for later AI data.
- [x] Log types are configurable per organization with custom fields (text, number, boolean,
      select, date; required; options), and work log values are validated against the definition
      by one function in `@ops/shared`.
- [x] Attachments are metadata only, and a `FileStorage` interface exists with no provider.
      (Superseded in Phase 4: a provider is bound, ADR-0006.)

Scope

- [x] A single scope-resolution service returns, for a user, the organization, sites, teams, and
      users they may see, with unit tests for the membership combinations, including a worker in
      several teams and a supervisor of a site plus a team (500 API unit tests pass, 2026-10-13).
      Nothing enforces it yet; that is Phase 3.

Audit and events

- [x] Every create, update, archive, restore, and status change writes one audit event (actor or
      `system`, action, entity, organization, before, after, diff, time, correlation id) through
      one service. The table is append-only, enforced by a database trigger.
- [x] The same transaction writes a domain event to the outbox. Events are exposed read-only;
      there is no consumer except tests.
- [x] Audit and outbox live in `src/platform` with no Operations imports, enforced by ESLint.

API

- [x] REST endpoints exist for organization, users, memberships, sites, teams, log types, tasks,
      work logs, attachment metadata, audit events (filtered), and outbox events (38 paths).
- [x] Request and response schemas for every endpoint live in `@ops/shared`, with a consistent
      error body, pagination, filtering by site, team, user, date range, and status, and sorting.
- [x] The health client is unified in `@ops/shared`, and the typed API client pattern exists and
      is used by the web and mobile apps.
- [x] Structured request logging with a correlation id per request (`x-request-id`).
- [x] The acting user came from a development-only header, gated by `NODE_ENV` and a flag, with a
      boot refusal outside development (checked 2026-10-13). Superseded: the header and the flag
      were removed in Phase 3.
- [x] OpenAPI / Swagger docs are generated from the API and served in development only
      (`/docs` lists 38 paths, 2026-10-13).

Seed

- [x] `pnpm db:seed` creates the demo organization "HZ Demo" with 2 sites, 3 teams, 10 users
      across all roles (including a worker in two teams and a supervisor scoped to a site), 3 log
      types, 8 tasks, and 25 work logs over 14 days (run once on 2026-10-13).
- [x] `pnpm db:reset` drops, migrates, and seeds. Run by the owner before the Phase 4 session
      (reported 2026-10-17). Agents must never run it.

Branding

- [x] Web and mobile show the client's brand (logo, name, page title, favicon, app icon, splash)
      from configuration, with a small "Powered by Kaneri.ai". Design tokens derived from the logo
      are shared by both apps, and the contrast pairings are unit tested against WCAG AA. Verified
      on 2026-10-13 as far as a build can show: the production web build has the title
      "HZ · Manager dashboard"; `expo export` succeeds for Android and iOS; `expo-doctor` 21/21.
- [x] The branding is seen in a real browser after `pnpm dev` is restarted: the owner signed in on
      the branded web pages as three roles (reported 2026-10-17).
- [ ] The app icon and splash screen are seen in a real build on a phone. Needs the Phase 4
      development build (Expo Go shows its own icon and splash).

Quality

- [x] Unit tests cover the services and shared logic: 500 in `@ops/api`, 432 in `@ops/shared`, 6
      in `@ops/web`, 8 in `@ops/mobile` (2026-10-13).
- [x] Integration tests run against PostgreSQL and are documented: `pnpm test:integration`, 532
      tests in 9 suites against `operations_app_test` (2026-10-13).
- [x] Root `pnpm install`, `build`, `lint`, `typecheck`, `test`, and `format:check` pass
      (2026-10-13).
- [x] Independent `reviewer` pass completed, "pass with fixes", no blockers; findings resolved
      (2026-10-13).
- [x] Accepted by the owner on review (2026-10-14). The owner's manual checks of the Phase 2 API
      (create a work log, see the matching audit and outbox events, open Swagger) are not recorded
      as run; the dev-header steps they used no longer exist, and the equivalent checks with
      sign-in are in the Phase 3 manual list (README section 4).
- [x] The Phase 2 work is reviewed and committed by the owner (commit `1fd2988` on `main`,
      2026-10-13).

## Phase 3: Authentication & permissions

**Goals**: replace the development header with real sign-in, and enforce on every route who can
see and do what, so the API is safe to expose to real users.

The criteria below were rewritten on 2026-10-16 to match the owner's Phase 3 prompt
(`docs/prompts/phase-3.md`). "Verified" means by the root checks, the unit and integration suites,
and the agents' HTTP and browser checks during the session (2026-10-14 to 2026-10-16), unless a
line says otherwise. One earlier criterion, "permission denials are written to the audit log", is
not in the prompt and was not built: security events are audited, 403 and 404 answers are not
(they appear in the request log line with the actor id).

**Done when**

Decisions and documentation

- [x] [ADR-0004](docs/decisions/0004-authentication.md) records in-house authentication behind an
      interface, with its tradeoffs and how SSO would plug in.
- [x] [ADR-0005](docs/decisions/0005-authorization-model.md) records the authorization model and
      the 404-versus-403 rule; [ARCHITECTURE.md](ARCHITECTURE.md) contains the permissions matrix
      (roles by resources by actions).
- [x] MEMORY.md, ARCHITECTURE.md, ROADMAP.md, README.md, AGENTS.md, and the folder `memory.md`
      files describe Phase 3 (docs-keeper, 2026-10-16).

Authentication

- [x] No public sign-up: an admin creates users (`POST /users`), each gets an expiring one-time
      activation code; an admin can issue a reset code. A notification sender interface exists with
      a development implementation that logs the code; the code is in the admin's response in
      development only.
- [x] Login with an email, a phone number, or a username, each unique within the organization.
- [x] Passwords hashed with argon2id, with a minimum policy, never logged or returned (the
      `secrets` integration suite checks logs, audit, and outbox).
- [x] Short-lived access token plus rotating refresh tokens, stored hashed with device info,
      revocable; reuse of a rotated token revokes the whole session.
- [x] Web: httpOnly, `Secure` outside development, `SameSite=Lax` cookies with CSRF protection
      (Origin allow-list plus a session-bound token).
- [x] Logout (this device) and logout everywhere. Archiving a user, archiving a membership, or
      reducing one revokes that user's sessions immediately.
- [x] Rate limits on login, activation and reset (`/auth/set-password`), and refresh; temporary
      lockout after repeated failures, which concurrent failures cannot clear; one generic error.
- [x] Every security event is audited (sign-in success and failure, logout, activation, reset,
      lockout, session revoked, refresh reuse, code issued, password changed); no password, code, or
      token in audit or outbox rows.
- [x] The `x-dev-user-id` path is removed from the running app; integration tests authenticate
      through the harness (`as(userId)` opens a real session).
- [x] All secrets come from environment variables validated at boot; the API refuses to start in
      production with a missing, placeholder, or weak signing secret, or a non-https `WEB_APP_URL`
      (boot refusal checked by the auth agent).
- [x] Seed users get development passwords defined only in the seed file (`DEV_PASSWORDS`), and
      README explains how to sign in as each seeded role. The owner's `pnpm db:reset` loaded the
      seed and sign-in works as `aylin`, `selin`, and `deniz` (reported 2026-10-17).
- [ ] Mobile: tokens in Expo SecureStore, sent as a bearer header. Code complete and unit tested;
      the session logic was run in mobile mode against the real API, and `expo export` and
      `expo-doctor` pass. **Not run on a device**: part of the Phase 4 phone test.

Permissions

- [x] One authorization layer: a policy decorator on every route, one global guard, a policy
      registry, and pure object-level rules; `route-policies.spec.ts` fails if any route has no
      policy or names an unregistered one, and the guard fails closed.
- [x] Visibility per role as decided (worker, supervisor, manager, admin), with the union over
      several memberships; queries are filtered at the data-access level from one visibility
      definition per resource; the resolved scope is cached per request.
- [x] Per-field rules: `authorId`, `createdById`, `uploadedById` set by the server (sent: 400);
      work logs created as `draft` or `submitted` only; authors edit within the organization's
      edit window (default 24 hours) and only while not approved; only a supervisor or above who
      can see a log approves or rejects it, never their own; workers change only the status of
      tasks assigned to them, not to `cancelled`; supervisors create and assign tasks within their
      scope, managers and admins organization-wide.
- [x] Only admins manage users, memberships, roles, and organization settings. Managers also manage
      log types, sites, and teams (justified in ADR-0005).
- [x] No one grants a role or scope higher than their own; the last active admin is protected.
- [x] Audit events are readable by admins only, filtered to their organization; the outbox route
      exists in development and test only and answers 404 for everyone in production; the Phase 2
      redaction rules still apply.
- [x] Responses contain only what the caller may see: explicit `basic`, `contact`, `full` user
      shapes and `summary` / `full` organization views.
- [x] 404 for records outside the caller's scope, 403 for visible records the caller may not
      change, documented in ADR-0005 and ARCHITECTURE.md.

Clients

- [x] `@ops/shared`: auth API functions and schemas; the typed client refreshes once on a 401 and
      never loops.
- [x] Web: branded login page, activation page, sign-out, sign-out everywhere, route protection
      (signed-out users go to `/login`), and the signed-in user's name and role (24/24 automated
      browser checks by the clients agent).
- [ ] Mobile: branded login and activation screens, secure token storage, sign-out, and a
      placeholder home screen with the user's name and role (replaced by the Phase 4 screens).
      Bundles and passes `expo-doctor`; **not yet seen on a device** (Phase 4 phone test).

Tests, review, verification

- [x] The `test-writer` covered every cell of the permissions matrix (535 tests) and the named
      cases: a worker cannot see another worker's logs, a supervisor cannot see outside scope,
      multi-membership union, nobody approves their own log, no escalation through memberships,
      server-set author fields, refresh rotation and reuse, lockout, an archived user's sessions
      revoked, no route without a policy, no secrets in logs, audit, or outbox.
- [x] An adversarial security review against the prompt, AGENTS.md, and the OWASP API Top 10
      returned "pass with fixes"; F1, F2, F3, F6 fixed, F4, F5, F7 accepted and documented in the
      ADRs.
- [x] Root `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `test:integration`, and
      `format:check` pass (2026-10-16). Unit: 367 api, 546 shared, 46 web, 20 mobile (re-run by
      the docs-keeper). Integration: 1,208 tests in 14 suites.
- [x] The auth migration `20261014090000_auth` is applied to the development database.
- [x] `pnpm build` passes. Not run in the Phase 3 final pass; reported passing with the Phase 4
      root checks (2026-10-17).
- [x] `pnpm db:reset` run by the owner, so the development database gets the Phase 3 seed
      (reported 2026-10-17).
- [x] `pnpm dev` starts everything and the owner signs in in a real browser as an admin, a
      supervisor, and a worker (`aylin`, `selin`, `deniz`; reported 2026-10-17). The other manual
      checks in README section 4 (Swagger per role, activation, lockout, sign-out everywhere) are
      not recorded as run.
- [x] The Phase 3 work is reviewed and committed by the owner (commit `8c8283a` on `main`).

## Phase 4: Mobile worker app

**Goals**: a field worker can use HZ on their phone for real work: sign in, see and update their
tasks, and create work logs with text, photos, location, and the custom fields of each log type.
Speed and simplicity of input come before feature count. Online only in this phase.

The criteria below were rewritten on 2026-10-17 to match the owner's Phase 4 prompt
(`docs/prompts/phase-4.md`). "Verified" means by the root checks, the unit and integration suites,
and the agents' checks against the real API and MinIO during the session (2026-10-16 to
2026-10-17). **Nothing has run on a phone yet**, so every item that needs a device stays open even
where the code is complete. Two items of the earlier Phase 4 plan are not in the prompt and were
not built: activation deep links into the app (not placed in a phase yet) and the signed-in state
when the server is unreachable at start (moved to Phase 5).

**Done when**

Decisions and documentation

- [x] [ADR-0006](docs/decisions/0006-file-storage-and-upload-flow.md) records the storage provider
      and why uploads go straight to storage through pre-signed URLs rather than through the API.
- [x] [ADR-0007](docs/decisions/0007-push-notifications-and-notification-channels.md) records push
      notifications, the notification-channel interface, and the outbox consumer.
- [x] README has a "Test on my phone" section: hotspot, `API_HOST`, `EXPO_PUBLIC_API_URL`, the
      storage address for signed URLs, Windows Firewall, Expo Go, the development build, and how
      to switch back.
- [x] MEMORY.md, ARCHITECTURE.md, ROADMAP.md, README.md, AGENTS.md, and the folder `memory.md`
      files describe Phase 4 (docs-keeper, 2026-10-17).

Worker app (code complete; every item needs the phone test)

- [ ] Login and activation work on a phone (Phase 3 screens, restyled).
- [ ] Home: tasks assigned to me (due today and overdue first), my recent logs, a big "New log"
      button.
- [ ] My tasks: filters (open, today, overdue, done), task detail, the status moves a worker may
      make (`in_progress`, `blocked` with a reason, `done`), and "Log work for this task".
- [ ] New work log: log types most-used first; a form generated from the custom fields (text,
      number, boolean, select, date) with required-field validation from the shared schemas; text,
      optional task, site, and team (pre-filled when obvious); photos from camera or gallery,
      several per log, resized on the phone, with upload progress and retry; location captured
      when permitted, with accuracy, never blocking the save; `occurredAt` defaulting to now; a
      `clientId` generated on the phone so a retried submit never duplicates. (The data path was
      run end to end against the real API: a log with custom fields, a duplicate `clientId`, a
      photo upload.)
- [ ] My logs: list and detail, edit within the window while not approved, approval status, and
      the rejection reason.
- [ ] Notifications: the in-app list (new task assigned, log approved or rejected) works on the
      phone.
- [ ] Profile: name, role, sign out, sign out everywhere, app version, "Powered by Kaneri.ai".
- [ ] Supervisors and managers get the same worker screens for their own work; no approval screens
      on mobile (built that way; check on the phone).

Design and usability

- [x] All user-facing text goes through an i18n layer (`apps/mobile/src/i18n/`), English now; a new
      language is a new catalogue file with no screen changes, and the layout is ready for right
      to left (`start` / `end`, `applyLayoutDirection`).
- [x] The form keeps what the worker typed until it is saved: the new-log form is drafted on the
      phone per user, a failed save keeps the form, and photos wait in a persisted upload queue.
      (Since Phase 5 the edit form is drafted too.)
- [ ] Large touch targets, readable in sunlight, one-handed and glove use, clear empty, loading,
      and error states, screen-reader labels, and dynamic text size, checked on a real phone.

Backend

- [x] File storage: the `FileStorage` interface has an S3-compatible implementation; MinIO runs in
      Docker Compose next to PostgreSQL, bound to `127.0.0.1` (verified against the real MinIO).
- [x] The API generates storage keys; clients never choose them (`storageKey` is gone from every
      request and response). This resolves finding F5.
- [x] Only JPEG and PNG are accepted, checked by content (magic bytes and a full decode), and the
      size limit is configurable (`UPLOAD_MAX_BYTES`, 10 MiB). HEIC and HEIF are converted to
      JPEG on the phone.
- [x] Downloads use short-lived signed URLs, issued only to users who may see the parent work log;
      nobody else can reach another worker's photos (`uploads` and `storage-minio` suites).
- [x] Thumbnails (320 px JPEG) are generated by the API on completion.
- [x] Push notifications sit behind a notification-channel interface in `src/platform` (reusable;
      Phase 7 can add channels), using Expo push.
- [x] Device push tokens are stored per user and session, removed on sign-out (seen live) and on
      every other session end, and when Expo reports them invalid (tests with a fake Expo client).
- [x] Notifications are triggered from outbox events: a task assigned to me, my log approved or
      rejected (`notifications` suite; seen live: the in-app notification within about one
      second).
- [x] Remote push in Expo Go was checked: Android Expo Go has none since SDK 53, iOS Expo Go works
      with an EAS project id. A development build is set up (`expo-dev-client`,
      `apps/mobile/eas.json`, `dev:client`) and README section 5 documents how to build and install
      it.
- [ ] A development build is built and installed on the owner's phone, and a push notification
      arrives on it through Expo.
- [x] New endpoints follow the Phase 3 rules: a declared policy on every route
      (`route-policies.spec.ts`), scope-filtered queries, role-shaped responses, audit and outbox
      on every business write (the matrix suite covers starting an upload and reading a ready
      attachment; `uploads`, `worker-app`, and `notifications` cover the rest).
- [x] The phone's data layer sends every write through one repository module
      (`apps/mobile/src/data/repositories.ts`), so Phase 5 can add a local queue without changing
      screens.

Tests, review, verification

- [x] The `test-writer` covered: form generation and validation for every custom field type,
      duplicate submit with the same `clientId`, upload validation (type, size, server-generated
      keys, no access to another worker's photos), the push token lifecycle, notifications only to
      the right users, worker task-status rules, and edit-window rules from the phone's calls.
- [x] The `reviewer` returned "pass with fixes" against the prompt, AGENTS.md, and the Phase 3
      security rules; M1, M2, and L1 to L6 fixed; rebinding, orphan bytes, per-process limits, and
      English-only server text accepted and documented.
- [x] Root install, build, lint, typecheck, test, `test:integration`, and `format:check` pass
      (2026-10-17). Unit: 477 api, 650 shared, 154 mobile, 46 web (re-run by the docs-keeper).
      Integration: 1,339 tests in 18 suites. `expo export` and `expo-doctor` 21/21.
- [x] The migration `20261017090000_phase4_mobile` is applied to the development database.
- [ ] `pnpm dev` starts everything, including MinIO, and the web app still works in a browser
      (the coordinator's final check).
- [ ] **The owner's phone test** (README section 5): as `deniz`, see tasks, change a task status,
      create a log with a photo, location, and custom fields, see it in My logs, edit it, sign out;
      as `selin`, approve that log through Swagger; `deniz` gets the notification. Carries the
      Phase 1 to 3 device checks (Expo Go reaches the API, SecureStore, sign-in on a device).
- [ ] App icon and splash screen seen in a development build.
- [ ] The final mobile bundle identifiers are decided (they come from `EXPO_IOS_BUNDLE_IDENTIFIER`
      and `EXPO_ANDROID_PACKAGE`; the default `ai.kaneri.operations` is a placeholder).
- [x] The Phase 4 work is committed (`280c50a`, 2026-10-17) and pushed to the private GitHub
      repository.

## Phase 5: Offline mode & sync

**Goals**: a worker can use the app fully offline for their own work (see their tasks, create and
edit logs with photos and location, change task status), and everything syncs automatically and
safely when the connection returns, with nothing lost and nothing duplicated.

The criteria below were rewritten on 2026-10-27 to match the owner's Phase 5 prompt
(`docs/prompts/phase-5.md`). "Verified" means by the unit and integration suites, the
`test-writer`, and the `reviewer` during the session of 2026-10-27. **Nothing has run on a phone
or in the emulator yet.**

**Done when**

Decisions and documentation

- [x] [ADR-0008](docs/decisions/0008-offline-storage-sync-and-conflicts.md) records the local
      storage, the sync protocol (no batch endpoint, with reasons), the conflict rules, row
      versions, the sequence diagram, and what is stored on the phone and for how long.
- [x] README section 6 documents the Android emulator test (`hz_pixel`, `adb reverse`, airplane
      mode) and an exact offline and conflict test.

Phone (code complete and tested with fakes; every item needs the emulator or phone test)

- [x] Reads come from a per-user local cache (SQLite) refreshed by `GET /sync/pull`, with "last
      refreshed" shown: assigned tasks, log types, sites and teams, recent own logs,
      notifications.
- [x] Creating a log (photos, location, custom fields), editing own logs, and changing task status
      go into a per-user local queue behind `apps/mobile/src/data/repositories.ts`; screens did not
      change their write calls.
- [x] Photos are stored on the phone, already resized, until uploaded, then deleted; a 500 MB limit
      with a warning at 80%.
- [x] Sync runs on reconnect, on foreground, after a write, on "Sync now", and in the background
      where the OS allows (development build only); in order per record, with exponential backoff
      and jitter.
- [x] Idempotent: `clientId` for creates (logs and photos), `Idempotency-Key` for edits and status
      changes; retries, a crash mid-send, and double taps create no duplicates (mobile and API
      tests).
- [x] Sync status UI: an indicator (synced, pending N, failed N, offline, sign in again), a Sync
      screen with reasons, retry, view, copy, resubmit as new, and discard; a state per work log.
- [x] The edit form keeps a draft like the new-log form does.
- [x] The app opens signed in from the stored identity when the server is unreachable; an expired
      session keeps the queue and asks to sign in again; another user on the same phone never sees
      or sends the previous user's data; sign-out with unsent items warns and offers sync first,
      keep for later, or discard.

Server

- [x] Every conflict rule of the prompt is implemented with a typed error code (`version_conflict`,
      `already_reviewed`, `edit_window_closed`, `task_cancelled`, `record_archived`, ...);
      optimistic concurrency with a row `version` on tasks and work logs.
- [x] Late offline logs are accepted within `offlineMaxBackdateDays` (default 7); the device time,
      server time, and clock skew are recorded, and large skews flagged.
- [x] Photos declared in a log's create are accepted for 30 days whatever the edit window; other
      photos after the window are refused (`attachment_not_declared`).
- [x] Every synced write goes through the normal policies, audit, and outbox; audit events of
      offline writes carry `via: offline_sync` with device and server time.
- [x] `GET /sync/pull` (policy `sync.pull`) is scoped by the caller's visibility and removes stale
      records through complete id sets.

Tests, review, verification

- [x] The `test-writer` covered retries, crashes, double taps, restarts, ordering per record, every
      conflict rule, late logs and photos, the `occurredAt` limit, token expiry offline, user
      switch, sign-out with pending items, the storage limit, and offline audit records (it found
      a double-save bug, fixed).
- [x] The `reviewer` returned "pass with fixes"; the blocking, major, and minor findings are fixed
      (see the MEMORY.md session log of 2026-10-27).
- [x] `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass (re-run by the docs-keeper,
      2026-10-27). Unit tests: 689 shared, 513 api, 46 web, 305 mobile (304 at the docs-keeper's
      run; one guard test added afterwards, as reported). Integration: 1,416 tests in 19 suites
      (as reported by the coordinator).
- [ ] The migration `20261027090000_phase5_offline_sync` is applied to the development database
      (needs the owner's `pnpm db:reset` first: the database holds a stray migration from lost
      work).
- [ ] The offline test in the Android emulator (README section 6), including the conflict case.
- [ ] Verified on a real phone in airplane mode, then back online.
- [ ] The Phase 5 work is committed and pushed.

## Phase 6: Web manager dashboard

**Goals**: supervisors and managers monitor work for their scope in the browser.

**Done when**

- [ ] Sign-in works on the web with the same accounts as mobile (the login, activation, and
      sign-out pages exist since Phase 3).
- [ ] Admin screens issue activation and reset codes and show a user's sessions.
- [ ] A list of work logs with filters for date, team, site, and worker, limited to the user's
      scope.
- [ ] A detail view with text, photos, and location.
- [ ] Supervisors approve and reject work logs with a note (the API and the notifications exist
      since Phase 4; there are no approval screens on mobile by design).
- [ ] Photos can be uploaded from the browser if needed, reusing `uploadAttachment` from
      `@ops/shared`; this needs a CORS rule on the bucket.
- [ ] Notification text is localised: each user's language is stored and the server renders the
      in-app and push text in it (English only since Phase 4).
- [ ] Admin screens manage users, roles, teams, and sites.
- [ ] A user cannot reach data outside their scope by editing a URL or request.
- [ ] Loading, empty, and error states exist for every view.
- [ ] Works at phone and desktop widths and meets basic accessibility checks.

## Phase 7: Intelligent layer v1 (smart capture, daily AI summaries)

**Goals**: the first AI features, built on top of the core without weakening permissions.

**Done when**

- [ ] An ADR records the AI provider, the provider abstraction, and data-handling constraints.
- [ ] The AI layer reads events through the outbox consumer (built in Phase 4, ADR-0007: it
      re-reads a 60-second window so a late-committing event is not missed) by registering its own
      handlers, and tests show it misses no event.
- [ ] AI alerts reach users through `NotificationService` and the notification channels (the
      in-app list and Expo push exist since Phase 4).
- [ ] The core runs normally with the AI layer disabled.
- [ ] Smart capture: the AI layer helps turn a worker's raw input into a structured work log, and
      the worker confirms before it is saved.
- [ ] Daily AI summaries are generated per scope and contain only data the recipient may see.
- [ ] Tests prove a summary for one scope never includes data from another.
- [ ] Any AI-proposed action requires human approval before it is executed.
- [ ] Prompts, model responses, proposals, approvals, and executed actions are audited.
- [ ] Provider failures and timeouts degrade gracefully and are logged.
- [ ] Cost and rate limits are configurable through environment variables.

## Phase 8: Hardening & release

**Goals**: ready for real users.

**Done when**

- [ ] Security review completed and findings resolved.
- [ ] A retention and erasure decision for personal data in the audit log and outbox is recorded
      in an ADR and implemented. The audit log is append-only, so personal data in it cannot be
      erased today.
- [ ] The audit log cannot be emptied by the application's database role (the append-only trigger
      does not block `TRUNCATE`).
- [ ] `pnpm db:reset` refuses to run against anything but a local development database (it has no
      guard on its target host today).
- [ ] CI runs lint, typecheck, test, build, and format check on every change.
- [ ] Production deployment for the API, web app, and database, with backups and a tested restore.
- [ ] Monitoring, alerting, and error reporting in place.
- [ ] Mobile release builds for iOS and Android submitted for store review or internal
      distribution.
- [ ] Performance checked against agreed targets on low-end phones and slow networks.
- [ ] Rate limiting and input size limits on the API. The `/auth/*` limits (Phase 3) and the
      upload limits (Phase 4) are in memory per process: bind a shared store (Redis or PostgreSQL)
      under `RATE_LIMITER` before running more than one API instance.
- [ ] Photo storage in production: a real S3-compatible provider, a private bucket with a bucket
      policy and a scoped key, HTTPS for `STORAGE_PUBLIC_ENDPOINT`; the community MinIO image
      replaced or built from source; a purge marker column so orphan upload bytes on ready
      attachments are removed (ADR-0006).
- [ ] Retention and erasure of stored photos are decided and implemented.
- [ ] Durable push receipts (a `PushTicket` table) instead of the in-memory tracking (ADR-0007).
- [ ] Activation and reset links open the mobile app's activation screen (deep links). Not in the
      Phase 4 prompt; listed here until the owner places it.
- [ ] `TRUST_PROXY_HOPS` is set to the exact number of reverse proxies in every deployment, so the
      per-IP limits see the client address.
- [ ] A real `NotificationSender` (email and/or SMS) delivers activation and reset codes; today
      codes are only logged, and only in development.
- [ ] The web app sends a Content-Security-Policy with `script-src` and `style-src` using
      per-request nonces (today only `frame-ancestors`, `base-uri`, `form-action`, `object-src`).
- [ ] HTTPS everywhere, with the web app and the API on the same site (or `AUTH_COOKIE_DOMAIN`
      set to the parent domain) and the exact web origin in `CORS_ORIGINS`.
- [ ] Log noise reviewed: `/health` logs an error on every call while the database is down, and
      a production API logs a warning for every one-time code it cannot deliver.
- [ ] Decide whether a lockout needs more than the per-identifier rate limit and an admin reset
      (anyone who knows an identifier can keep that account locked; finding F4, ADR-0004).
- [ ] Runbook written: deploy, roll back, restore, rotate secrets.
