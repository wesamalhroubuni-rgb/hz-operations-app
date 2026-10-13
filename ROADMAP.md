# ROADMAP.md

Eight phases. A phase is done only when every "done when" item is verified, not merely written.
Tick an item when it has been checked and note the date in [MEMORY.md](MEMORY.md). Criteria for
Phases 2 to 8 are the current plan and should be refined at the start of each phase.

| Phase | Name                         | Status                                   |
| ----- | ---------------------------- | ---------------------------------------- |
| 1     | Setup & architecture         | Code complete, manual checks outstanding |
| 2     | Backend core                 | Next                                     |
| 3     | Authentication & permissions | Planned                                  |
| 4     | Mobile worker app            | Planned                                  |
| 5     | Offline mode & sync          | Planned                                  |
| 6     | Web manager dashboard        | Planned                                  |
| 7     | Intelligent layer v1         | Planned                                  |
| 8     | Hardening & release          | Planned                                  |

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
- [ ] The PostgreSQL container starts with `pnpm db:up` (needs a reboot to finish the WSL 2 and
      Docker Desktop install).
- [ ] `GET /health` returns 200 with `database: 'up'`.
- [ ] `pnpm --filter @ops/api db:migrate` runs against the database.
- [ ] The web "API status" card shows the correct state in a real browser.
- [ ] The mobile app opens on a real phone in Expo Go and shows "API reachable".
- [x] Independent `reviewer` pass completed and its should-fix findings resolved (2026-10-12).
- [ ] Git identity configured and the first commit made.

## Phase 2: Backend core (data models, API, audit log)

**Goals**: the data model and REST API for the core application, with an audit log from the start.
No AI. Authentication comes in Phase 3, so endpoints in this phase are not yet protected and must
not be exposed beyond local development.

**Done when**

- [ ] Open questions on scope (team, site, or both) and tenancy are answered in an ADR.
- [ ] Prisma models and the first migration exist for users, teams, sites, and work logs.
- [ ] Request and response schemas for every endpoint live in `@ops/shared`.
- [ ] REST endpoints create, read, update, and list work logs, with input validation and
      consistent error responses.
- [ ] An audit log module records every create, update, and delete with actor, action, target, and
      time, and is written as a self-contained platform module.
- [ ] Photo attachments have a storage abstraction and a local development implementation.
- [ ] Structured request logging with a correlation identifier per request.
- [ ] Unit tests cover the services; integration tests run against PostgreSQL and are documented.
- [ ] Root `pnpm build`, `lint`, `typecheck`, `test`, and `format:check` pass.

## Phase 3: Authentication & permissions

**Goals**: users sign in, and the API enforces role and scope on every request.

**Done when**

- [ ] An ADR records the authentication mechanism.
- [ ] Users can sign in and out; the API rejects unauthenticated requests to protected endpoints.
- [ ] The four roles (worker, supervisor, manager, admin) exist and are assignable by an admin.
- [ ] Scope by team and site is enforced in the API at the data-access level.
- [ ] Every permission rule has tests for the allowed and the denied case, including a user outside
      the team or site scope.
- [ ] Auth and permissions are self-contained modules with no Operations-specific imports.
- [ ] Sign-in, sign-out, and permission denials are written to the audit log.
- [ ] No secrets in the repository; all auth settings come from environment variables.

## Phase 4: Mobile worker app

**Goals**: a worker can sign in on a phone and log work with text, photos, and location. Online
only in this phase.

**Done when**

- [ ] Sign-in and sign-out work on iOS and Android.
- [ ] A worker can create a work log with text, one or more photos, and the current location.
- [ ] A worker can see the list and detail of their own work logs, and nothing else.
- [ ] Camera and location permissions are requested with a clear explanation and handled when
      denied.
- [ ] Network and server errors are shown clearly and can be retried.
- [ ] App icon and splash screen assets are in place.
- [ ] Logic outside components is unit tested; the flows are verified on a real Android phone and a
      real iPhone.

## Phase 5: Offline mode & sync

**Goals**: a worker can log work with no network, and it reaches the server later exactly once.

**Done when**

- [ ] An ADR records the local database and the conflict rule.
- [ ] Work logs and attachments are written to a local store first.
- [ ] An outbox queue sends pending changes when the network returns, with retry and backoff.
- [ ] Sync is idempotent: resending the same change does not create a duplicate.
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
- [ ] The core emits events that the AI layer consumes; the core runs normally with the AI layer
      disabled.
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
- [ ] CI runs lint, typecheck, test, build, and format check on every change.
- [ ] Production deployment for the API, web app, and database, with backups and a tested restore.
- [ ] Monitoring, alerting, and error reporting in place.
- [ ] Mobile release builds for iOS and Android submitted for store review or internal
      distribution.
- [ ] Performance checked against agreed targets on low-end phones and slow networks.
- [ ] Rate limiting and input size limits on the API.
- [ ] Runbook written: deploy, roll back, restore, rotate secrets.
