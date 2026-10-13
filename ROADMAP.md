# ROADMAP.md

Eight phases for HZ. A phase is done only when every "done when" item is verified, not merely
written. Tick an item when it has been checked and note the date in [MEMORY.md](MEMORY.md).
Criteria for Phases 3 to 8 are the current plan and should be refined at the start of each phase.

| Phase | Name                         | Status                                                          |
| ----- | ---------------------------- | --------------------------------------------------------------- |
| 1     | Setup & architecture         | Done except two checks: one pending, one deferred to Phase 4    |
| 2     | Backend core                 | Code complete; the owner's manual checks and commit outstanding |
| 3     | Authentication & permissions | Next                                                            |
| 4     | Mobile worker app            | Planned                                                         |
| 5     | Offline mode & sync          | Planned                                                         |
| 6     | Web manager dashboard        | Planned                                                         |
| 7     | Intelligent layer v1         | Planned                                                         |
| 8     | Hardening & release          | Planned                                                         |

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
permission enforcement come in Phase 3, so the API is protected only by a development-only header
and must not be exposed beyond the developer's machine.

The criteria below were rewritten on 2026-10-13 to match the owner's Phase 2 prompt
(`docs/prompts/phase-2.md`). One earlier criterion, "a local development implementation" of photo
storage, moved to Phase 4: the prompt asks for a storage interface only.

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
- [x] The acting user comes from the development-only `x-dev-user-id` header, honoured only when
      `NODE_ENV=development` and `DEV_AUTH_ENABLED=true`. The API refuses to boot with the flag
      in any other environment (checked for production, test, and unset on 2026-10-13), and the
      guard re-checks independently.
- [x] OpenAPI / Swagger docs are generated from the API and served in development only
      (`/docs` lists 38 paths, 2026-10-13).

Seed

- [x] `pnpm db:seed` creates the demo organization "HZ Demo" with 2 sites, 3 teams, 10 users
      across all roles (including a worker in two teams and a supervisor scoped to a site), 3 log
      types, 8 tasks, and 25 work logs over 14 days (run once on 2026-10-13).
- [ ] `pnpm db:reset` drops, migrates, and seeds. The script exists but **has never been
      executed**. It must be run by a person: Prisma refuses `migrate reset` when it detects an AI
      agent.

Branding

- [x] Web and mobile show the client's brand (logo, name, page title, favicon, app icon, splash)
      from configuration, with a small "Powered by Kaneri.ai". Design tokens derived from the logo
      are shared by both apps, and the contrast pairings are unit tested against WCAG AA. Verified
      on 2026-10-13 as far as a build can show: the production web build has the title
      "HZ · Manager dashboard"; `expo export` succeeds for Android and iOS; `expo-doctor` 21/21.
- [ ] The branding is seen in a real browser after `pnpm dev` is restarted. Pending.
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
- [ ] The owner has run the manual checks listed in [README.md](README.md) (create a work log, see
      the matching audit and outbox events, open Swagger).
- [ ] The Phase 2 work is reviewed and committed by the owner. Nothing from Phase 2 is committed
      yet.

## Phase 3: Authentication & permissions

**Goals**: users sign in, and the API enforces role and scope on every request.

**Done when**

- [ ] An ADR records the authentication mechanism.
- [ ] Users can sign in and out; the API rejects unauthenticated requests to protected endpoints.
- [ ] The dev header is gone: `apps/api/src/platform/dev-auth/`, `DEV_AUTH_ENABLED`, and
      `DEV_USER_HEADER` are removed, and `API_HOST` no longer needs to be loopback for safety.
- [ ] The four roles (worker, supervisor, manager, admin) are assignable by an admin only.
- [ ] An ADR defines the **record-visibility rule**: how `siteIds`, `teamIds`, `userIds`, and
      `memberOf` from the resolved scope combine for one record, including a worker with no site
      or team whose work log carries a supervisor's site.
- [ ] Scope by team and site is enforced in the API at the data-access level, using
      `ScopeService`, with the resolved scope cached per request.
- [ ] **Per-field permissions** on request bodies. Today a body is trusted: any user can set
      `authorId` to someone else, send `status: 'approved'`, edit an approved work log, and get
      the stored log of any user in the organization back by retrying its `clientId`.
- [ ] **Status transition rules** for work logs and tasks (who may move what from which status).
- [ ] Access to `GET /audit-events` and `GET /outbox-events` is restricted. They hold full entity
      snapshots, including email, phone, free text, and GPS positions.
- [ ] Every permission rule has tests for the allowed and the denied case, including a user outside
      the team or site scope.
- [ ] Auth and permissions are self-contained modules with no Operations-specific imports.
- [ ] Sign-in, sign-out, and permission denials are written to the audit log.
- [ ] No secrets in the repository; all auth settings come from environment variables.

## Phase 4: Mobile worker app

**Goals**: a worker can sign in on a phone and log work with text, photos, and location. Online
only in this phase.

**Done when**

- [ ] **Phone test** (carried over from Phases 1 and 2): the app opens on a real phone and reaches
      the API over Wi-Fi, on a network that allows phone-to-PC traffic, with `API_HOST=0.0.0.0`.
- [ ] Sign-in and sign-out work on iOS and Android.
- [ ] The API generates attachment storage keys itself, prefixed with the organization id, and
      `storageKey` is removed from the create body, **before** any storage provider is bound.
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

- [ ] Sign-in works on the web with the same accounts as mobile.
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
- [ ] Rate limiting and input size limits on the API.
- [ ] Runbook written: deploy, roll back, restore, rotate secrets.
