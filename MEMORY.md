# MEMORY.md

Current state of the HZ project (repository folder `Operations_App`, packages `@ops/*`). Update this
file at the end of every session. Newest session log entry goes first. Last updated: 2026-10-16.

## Current phase

**Phase 3 (Authentication & permissions): code complete, pending the owner's manual checks,
`pnpm db:reset`, and commit.** Nothing from Phase 3 is committed; `main` has Phase 1 (`d03c843`)
and Phase 2 (`1fd2988`). **Phase 4 (Mobile worker app) is next.** Phases are defined in
[ROADMAP.md](ROADMAP.md).

**HZ** is the client's product name. Kaneri.ai builds and powers it. "Operations" remains the
technical name of the folder, the packages, the API domain folder, and the database.

## What exists

| Area              | State                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo          | pnpm 12 workspaces + Turborepo 2. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `format`, `format:check`, `db:up`, `db:down`, `db:logs`, `db:migrate`, `db:seed`, `db:reset`.                                                                      |
| `packages/config` | Shared ESLint 10 flat config, Prettier config, three tsconfig presets. Unchanged since Phase 1.                                                                                                                                                                                     |
| `packages/shared` | Zod schemas and endpoint functions for every resource and `/auth/*`, the transport (refreshes once on a 401), `createAuthSessionManager` (web and mobile modes), shared auth wording and form validation, the health monitor, custom-field validation, design tokens.               |
| `apps/api`        | NestJS 12 API, 49 paths. Platform: in-house sign-in and sessions (`src/platform/auth`), the policy seam (`src/platform/authz`), notification sender interface, audit log, outbox. Domain: the access layer (`src/operations/access`) on every route, plus the Phase 2 resources.    |
| `apps/web`        | Next.js 16.4: `/login`, `/activate`, and a protected `/` showing the user's name, role, organization, "Sign out", "Sign out everywhere", and the API status card. Security headers in `next.config.ts`.                                                                             |
| `apps/mobile`     | Expo SDK 57: Login, Activate, and Home screens chosen by sign-in state (no navigation library), tokens in `expo-secure-store`. Never run on a phone.                                                                                                                                |
| Database          | PostgreSQL 17 in Docker Compose on `127.0.0.1`. Three migrations applied to `operations_app` (the third, `20261014090000_auth`, on 2026-10-14). Its data is still the Phase 2 seed (see "Machine and repository state"). `operations_app_test` is created by the integration tests. |
| Docs              | `AGENTS.md`, this file, `ARCHITECTURE.md` (with the permissions matrix), `ROADMAP.md`, `README.md`, ADR-0001 to ADR-0005, a `memory.md` in each app and package, the owner's phase prompts in `docs/prompts/`, the logo files in `docs/brand/`.                                     |
| Subagents         | `reviewer`, `docs-keeper`, `test-writer` in `.claude/agents/`.                                                                                                                                                                                                                      |

Not built yet: file upload or storage, any feature screen in web or mobile, offline storage, real
email or SMS delivery, push notifications, an outbox consumer, and the AI layer. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Signing in

- Users sign in with an email, phone number, or username plus a password (`POST /auth/login`,
  `client: 'web'` for cookies or `'mobile'` for bearer tokens). There is no other way to get an
  acting user; the development header is gone.
- Demo users: identifiers per role are in README section 4. **Development passwords are defined
  only in the `DEV_PASSWORDS` constant in `apps/api/src/operations/seed/demo-seed.ts`**, one per
  role. Never copy them into a document, a log, or chat output.
- New users get a one-time activation code from an admin (`POST /users`); in development the code
  and link are in the response and the API log. Reset codes: `POST /users/:id/password-reset`.
- **The development database has not been re-seeded yet**: until the owner runs `pnpm db:reset`,
  its demo users have no usernames and no known passwords, so nobody can sign in to it.

## Verified

**Phase 2 acceptance**: the owner reviewed the Phase 2 report and asked to proceed to Phase 3 on
2026-10-14; Phase 2 is committed as `1fd2988` (2026-10-13). From the Phase 2 "Not yet verified"
list, only the commit is confirmed. Still unconfirmed: `pnpm db:reset` has never run; the owner
has not recorded looking at the branding or the status card's recovery in a real browser; nothing
has run on a phone (Phase 4); the owner's manual API checks of README section 4 (Phase 2 version)
are not recorded as run, and those dev-header steps no longer exist. The stale `pnpm dev` noted on
2026-10-13 is gone: the owner was running a fresh `pnpm dev` during the Phase 3 session.

**In the Phase 3 session (2026-10-14 to 2026-10-16)**

- Root `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:integration`, and `pnpm format:check` pass (2026-10-16).
- Unit tests: 367 in `@ops/api` (15 suites), 546 in `@ops/shared` (11 files), 46 in `@ops/web`
  (3 files), 20 in `@ops/mobile` (3 suites). The docs-keeper re-ran each package's test runner on
  2026-10-16 and confirmed these counts.
- Integration tests: 1,208 tests in 14 suites, about 150 seconds, against `operations_app_test`
  only, including `permissions-matrix` (535 tests, every cell), `permissions-cases`,
  `auth-login`, `auth-sessions`, and `secrets` (no password, code, or token in logs, audit, or
  outbox). Not re-run by the docs-keeper.
- The auth migration `20261014090000_auth` is applied to the development database.
- Over HTTP with real sign-ins, on agent-started API instances: the auth agent checked cookies,
  CSRF, refresh rotation and reuse, lockout, rate limiting, and the production boot refusal; the
  authorization agent ran 37 permission checks; the clients agent ran 24/24 automated browser
  checks of the web app, the mobile session logic in mobile mode against the real API,
  `expo export`, and `expo-doctor`.
- An adversarial security review (OWASP API Top 10) returned "pass with fixes"; the fixes are in
  the session log.

## Not yet verified

1. **`pnpm db:reset` and the new seed on the development database.** The owner must run it: Prisma
   refuses `migrate reset` in an AI agent environment, and the agent permission system blocked it.
2. **The full `pnpm dev` with sign-in in a real browser, by the owner**, as an admin, a supervisor,
   and a worker, plus the manual checks in README section 4 (Swagger per role, activation, lockout,
   sign-out everywhere).
3. **`pnpm build`** was not run in the final pass, because the owner's `pnpm dev` was running and
   `nest build` deletes `apps/api/dist` under it.
4. **Anything on a phone**: Expo Go reaching the API, the Login, Activate, and Home screens,
   SecureStore, icon and splash. Deferred to Phase 4; the campus Wi-Fi blocks phone-to-PC traffic.
5. The web status card's automatic recovery, watched by a person in a real browser (unit tested).

## Machine and repository state

- Node 24.20.0, pnpm 12.11.2, Git 2.55, Docker Desktop with the WSL 2 backend. Windows long paths
  enabled.
- Docker and PostgreSQL run. Docker Desktop stopped on its own once on 2026-10-13 (cause unknown);
  `docker desktop restart` brought it back.
- Branch `main`, two commits (`d03c843` Phase 1, `1fd2988` Phase 2). All Phase 3 work is
  uncommitted in the working tree, including the untracked `docs/prompts/phase-3.md`.
- The local `.env` (git-ignored) has every key of `.env.example`, including the Phase 3 `AUTH_*`
  variables, `WEB_APP_URL`, `TRUST_PROXY_HOPS`, and both organization slug variables (checked by
  key name only on 2026-10-16).
- **Development database contents**: the Phase 2 demo seed plus leftovers from Phase 2 manual
  checks, with the auth migration applied on top. No user has a username or a password.
  `pnpm db:reset` gives the clean Phase 3 seed.
- User ids are generated, so they change on every reset. Sign in with identifiers instead.

## Known limitations

Security (accepted for now; see ADR-0004 and ADR-0005)

- **Rate limits are in memory, per process.** Several API instances count separately and a
  restart forgets everything. A shared store is needed before scaling out (Phase 8).
- **Lockout is a targeted denial of service**: anyone who knows an identifier can keep that
  account locked. An admin password reset clears it (finding F4).
- **Behind a reverse proxy, `TRUST_PROXY_HOPS` must be set exactly**, or every client shares the
  proxy's IP limit (or can choose its own IP).
- **One-time codes are not delivered.** The logging sender shows them only in development; in
  production an admin gets no code in the response and nobody receives one until a real sender is
  bound (Phase 8).
- **The client chooses the attachment `storageKey`**, and a duplicate answers 409 even for an
  attachment the caller cannot see (F5). Phase 4 makes the API generate it.
- **`clientId` reuse by another user answers 409**, revealing that some log with that UUID exists
  (F7, accepted as negligible).
- **No `script-src` / `style-src` Content-Security-Policy on the web app** yet; it needs nonces.
- The refresh-token grace window (10 seconds) means a replay within that window is not detected as
  reuse (it gets nothing).
- Permission denials (403, 404) are not written to the audit log; they appear in the request log
  line with the actor id.
- The audit log is append-only, so personal data in it cannot be erased. The trigger blocks
  `UPDATE` and `DELETE` but not `TRUNCATE`.
- Tenancy and scope are enforced in application code only (no composite foreign keys, no
  row-level security).
- `pnpm db:reset` has no guard on its target: it resets whatever `DATABASE_URL` points at.
- Production needs HTTPS, the web app and the API on the same site (or `AUTH_COOKIE_DOMAIN`), and
  the exact web origin in `CORS_ORIGINS`.

Behaviour

- Redaction in audit and outbox events is by key name at any depth (a custom field keyed
  `token_no` is stored as `"[redacted]"` there).
- Old log type definitions are not kept; a work log's `logTypeVersion` resolves only through the
  audit log.
- No optimistic locking or row version: concurrent updates are last-write-wins.
- Outbox sequence numbers are assigned at insert, not at commit.
- Scope resolution reads every membership, site, and team of the organization once per request.
- Only users, sites, and teams can be restored.
- Every authenticated request reads the session and the user from the database.
- `/health` logs an error on every call while the database is down; a production API logs a
  warning for every one-time code it cannot deliver.

Clients and tooling

- The web route guard is a convenience only; the API is the authority.
- The mobile app has no navigation library, no activation deep links (links open the web page),
  and signs in online only. The home screen is a placeholder.
- `API_HOST=127.0.0.1` means a phone cannot reach the API; a phone test needs `API_HOST=0.0.0.0`
  on a trusted network and `EXPO_PUBLIC_API_URL` set to the PC's Wi-Fi address.
- Expo Go shows its own icon and splash; the `expo-secure-store` config plugin applies only in a
  development or release build. There is no mobile `build` script.
- The mobile bundle identifiers (`ai.kaneri.operations`) are hard-coded in `app.config.ts`.
- `expo start --tunnel` is not available (no `@expo/ngrok`).
- `.env` is a global Turbo dependency, so editing any value invalidates every cached task.
- Root `pnpm dev` runs Expo under Turbo, where the QR code may not appear; run
  `pnpm --filter @ops/mobile dev` in its own terminal.
- `nest build` deletes `apps/api/dist`, which breaks a running `pnpm dev` API until it recompiles.
- Integration tests are not part of `pnpm test` and there is no CI pipeline.
- Product-name leftovers in code: the `description` fields in the `package.json` files and the
  Swagger description in `apps/api/src/main.ts` still say "Operations App".

## Open questions

- Phase 4: which object storage provider for photos, and what are the size and retention limits?
  What are the final mobile bundle identifiers, and where do they come from? Which deep-link
  scheme or universal link should activation links use, so they open the app?
- Phase 4: how long may the app stay signed in offline, and what does it show when the session
  turns out to be revoked on reconnect?
- Phase 5: which local database, and what is the conflict rule? Does the server need a row
  version?
- Phase 6: which admin screens are needed for users, memberships, codes, and sessions? Log types
  and their custom fields are manageable only through the API today.
- Before production: which email or SMS provider delivers one-time codes, and is the code sent as
  a link, as text, or both? Who in the client's organization holds the admin role?
- Before production: is the lockout acceptable as is (F4), or does it need a CAPTCHA or risk-based
  rule? Should 403 and 404 answers be audited?
- Phase 6 or later: which push notification provider, and are notifications needed earlier?
- Phase 7: which AI provider and hosting constraints (data residency, cost limits)? How does the
  outbox consumer avoid missing late-committing events?
- Before Phase 8: retention and erasure of personal data in the append-only audit log and the
  outbox (including the IP addresses and user agents stored on sessions).
- Before a second client: does tenancy need database-level enforcement? (A second organization
  also makes the organization slug mandatory at sign-in.)
- Why did Docker Desktop stop on its own on 2026-10-13?

Answered in Phase 3 (see [ADR-0004](docs/decisions/0004-authentication.md) and
[ADR-0005](docs/decisions/0005-authorization-model.md)): the authentication mechanism (in-house,
behind an interface); the record-visibility rule; per-field rules and status transitions; who
reads audit and outbox events (admins; outbox in development and test only); scope caching (per
request); who manages log types (managers and admins).

## Session log

### 2026-10-14 to 2026-10-16: Phase 3 authentication and permissions

- **Starting point**: on 2026-10-14 the owner reviewed the Phase 2 report and asked to proceed;
  that review is the record of the Phase 2 manual checks (see "Verified" for which items remain
  unconfirmed). Phase 2 was already committed (`1fd2988`).
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
    `storageKey` until Phase 4 (F5), the `clientId` 409 oracle (F7).
  - Coordinator decision: logout relies on the Origin check alone (no CSRF token), so it works
    with an expired access token; the worst case is a forced sign-out.
- **Verified**: see "Verified" above.
- **Left to do**
  - Owner: run `pnpm db:reset`; restart `pnpm dev`; sign in on the web as an admin, a supervisor,
    and a worker; run the manual checks in README section 4; run `pnpm build` when the dev server
    is stopped; review and commit.
  - Carried to Phase 4: server-generated attachment storage keys, activation deep links in the
    mobile app, the signed-in state offline, mobile bundle identifiers, the phone test.
  - Carried to Phase 8: a shared rate-limit store, `TRUST_PROXY_HOPS` in deployment, a CSP with
    `script-src` nonces, a real notification sender, retention and erasure of personal data in
    audit and outbox, a `db:reset` guard, log noise.

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
  2026-10-14; the rest is listed under "Verified" and "Not yet verified" above.

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
