# ROADMAP.md

Eight phases for HZ. A phase is done only when every "done when" item is verified, not merely
written. Tick an item when it has been checked and note the date in [MEMORY.md](MEMORY.md).
Criteria for Phases 3 to 8 are the current plan and should be refined at the start of each phase.

| Phase | Name                         | Status                                                        |
| ----- | ---------------------------- | ------------------------------------------------------------- |
| 1     | Setup & architecture         | Done except two checks: one pending, one deferred to Phase 4  |
| 2     | Backend core                 | Accepted and committed (`1fd2988`); three checks still open   |
| 3     | Authentication & permissions | Code complete; owner's manual checks, `db:reset`, commit open |
| 4     | Mobile worker app            | Next                                                          |
| 5     | Offline mode & sync          | Planned                                                       |
| 6     | Web manager dashboard        | Planned                                                       |
| 7     | Intelligent layer v1         | Planned                                                       |
| 8     | Hardening & release          | Planned                                                       |

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
- [ ] The mobile app opens on a real phone in Expo Go and shows "API reachable". **Deferred to
      Phase 4**: the campus Wi-Fi blocks phone-to-PC traffic.
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
- [ ] `pnpm db:reset` drops, migrates, and seeds. The script exists but **has never been
      executed** (still true on 2026-10-16). It must be run by the owner: Prisma refuses
      `migrate reset` in an AI agent environment, and the agent permission system blocks it.
      Carried into the Phase 3 owner checks, where it is needed anyway.

Branding

- [x] Web and mobile show the client's brand (logo, name, page title, favicon, app icon, splash)
      from configuration, with a small "Powered by Kaneri.ai". Design tokens derived from the logo
      are shared by both apps, and the contrast pairings are unit tested against WCAG AA. Verified
      on 2026-10-13 as far as a build can show: the production web build has the title
      "HZ · Manager dashboard"; `expo export` succeeds for Android and iOS; `expo-doctor` 21/21.
- [ ] The branding is seen in a real browser after `pnpm dev` is restarted. Not recorded as done
      by the owner. (During the Phase 3 session the clients agent ran automated browser checks of
      the web app; the owner's own look is part of the Phase 3 manual checks.)
- [ ] The app icon and splash screen are seen in a real build on a phone. **Deferred to Phase 4**
      (Expo Go shows its own icon and splash).

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
- [ ] Seed users get development passwords defined only in the seed file (`DEV_PASSWORDS`), and
      README explains how to sign in as each seeded role. The code and the README section exist;
      **the new seed has not run against the development database** (it needs `pnpm db:reset`,
      below). Until then the demo users there have no usernames and no known passwords.
- [ ] Mobile: tokens in Expo SecureStore, sent as a bearer header. Code complete and unit tested;
      the session logic was run in mobile mode against the real API, and `expo export` and
      `expo-doctor` pass. **Not run on a device**: that is the Phase 4 phone test.

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
      placeholder home screen with the user's name and role. Bundles and passes `expo-doctor`;
      **not yet seen on a device** (Phase 4 phone test).

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
- [ ] `pnpm build` passes. Not run in the final pass, because the owner's `pnpm dev` was running
      and `nest build` deletes `apps/api/dist` under it.
- [ ] `pnpm db:reset` run by the owner, so the development database gets the Phase 3 seed.
- [ ] `pnpm dev` starts everything and the owner signs in in a real browser as an admin, a
      supervisor, and a worker, and runs the manual checks in README section 4 (what each role
      sees in Swagger, the activation flow, lockout, sign-out everywhere).
- [ ] The Phase 3 work is reviewed and committed by the owner.

## Phase 4: Mobile worker app

**Goals**: a worker can sign in on a phone and log work with text, photos, and location. Online
only in this phase.

**Done when**

- [ ] **Phone test** (carried over from Phases 1 and 2): the app opens on a real phone and reaches
      the API over Wi-Fi, on a network that allows phone-to-PC traffic, with `API_HOST=0.0.0.0`.
- [ ] Sign-in, activation, sign-out, and sign-out everywhere work on iOS and Android, with the
      tokens in SecureStore (built in Phase 3, never run on a device).
- [ ] Activation and reset links open the mobile app's activation screen (deep links; deferred
      from Phase 3, where the link points at the web app's `/activate`).
- [ ] The app opens signed in from the stored session when the network is down, and does not sign
      the user out because the server is unreachable (deferred from Phase 3).
- [ ] The API generates attachment storage keys itself, prefixed with the organization id, and
      `storageKey` is removed from the create body, **before** any storage provider is bound.
      This also removes the 409 a duplicate key gives today for an attachment the caller cannot
      see (security review finding F5, ADR-0005).
- [ ] A `FileStorage` provider is bound, including a local development implementation (moved here
      from Phase 2), and photos can be uploaded and downloaded.
- [ ] A worker can create a work log with text, one or more photos, and the current location.
- [ ] A worker can see the list and detail of their own work logs, and nothing else.
- [ ] Camera and location permissions are requested with a clear explanation and handled when
      denied.
- [ ] Network and server errors are shown clearly and can be retried.
- [ ] The mobile bundle identifiers (`ai.kaneri.operations` today, hard-coded in `app.config.ts`)
      come from configuration and are decided before the first store or development build.
- [ ] App icon and splash screen are seen in a real build (the assets and configuration exist
      since Phase 2).
- [ ] Logic outside components is unit tested; the flows are verified on a real Android phone and a
      real iPhone.

## Phase 5: Offline mode & sync

**Goals**: a worker can log work with no network, and it reaches the server later exactly once.

**Done when**

- [ ] An ADR records the local database and the conflict rule, including whether the server needs
      a row version (there is no optimistic locking today; concurrent updates are
      last-write-wins).
- [ ] Work logs and attachments are written to a local store first.
- [ ] An outbox queue sends pending changes when the network returns, with retry and backoff.
- [ ] Sync is idempotent: resending the same change does not create a duplicate. (The server side
      for work log creation exists since Phase 2: `clientId`.)
- [ ] Conflicts are detected and resolved by the documented rule.
- [ ] The app shows sync state (pending, synced, failed) per work log.
- [ ] Tests cover duplicate, out-of-order, and interrupted sync.
- [ ] Verified on a real phone in airplane mode, then back online.

## Phase 6: Web manager dashboard

**Goals**: supervisors and managers monitor work for their scope in the browser.

**Done when**

- [ ] Sign-in works on the web with the same accounts as mobile (the login, activation, and
      sign-out pages exist since Phase 3).
- [ ] Admin screens issue activation and reset codes and show a user's sessions.
- [ ] A list of work logs with filters for date, team, site, and worker, limited to the user's
      scope.
- [ ] A detail view with text, photos, and location.
- [ ] Admin screens manage users, roles, teams, and sites.
- [ ] A user cannot reach data outside their scope by editing a URL or request.
- [ ] Loading, empty, and error states exist for every view.
- [ ] Works at phone and desktop widths and meets basic accessibility checks.

## Phase 7: Intelligent layer v1 (smart capture, daily AI summaries)

**Goals**: the first AI features, built on top of the core without weakening permissions.

**Done when**

- [ ] An ADR records the AI provider, the provider abstraction, and data-handling constraints.
- [ ] An outbox consumer exists and cannot miss events. Sequence numbers are assigned at insert,
      not at commit, so a cursor-only reader can skip an event from a late-committing transaction;
      the consumer must re-read a window or use `processedAt`.
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
- [ ] Rate limiting and input size limits on the API. The `/auth/*` limits exist since Phase 3 but
      are in memory per process: bind a shared store (Redis or PostgreSQL) under `RATE_LIMITER`
      before running more than one API instance.
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
