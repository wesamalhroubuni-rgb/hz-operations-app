WORKING DIRECTORY: D:\Personal Projects\Huseyin\Operations_App

PHASE 3 of 8 — Authentication and permissions

## Start of session
Follow AGENTS.md: read AGENTS.md → MEMORY.md → ARCHITECTURE.md → ROADMAP.md → ADR-0002 and ADR-0003 → apps/api/memory.md, packages/shared/memory.md, apps/web/memory.md, apps/mobile/memory.md.

Phase 2 is complete and reviewed. Before changing anything, run `pnpm db:up`, then build, lint, typecheck, test and `pnpm test:integration` to confirm the starting point is green. If anything fails, report it and fix it first. Note in MEMORY.md which Phase 2 manual checks were done (the user reviewed the Phase 2 report and asked to proceed).

## Goal
Replace the development header with real login, and enforce on every route who can see and do what. After this phase the API is safe to expose to real users.

## Authentication
Use in-house authentication behind an interface, so an external provider or company SSO can be added later without touching business modules. Record the choice in ADR-0004 with tradeoffs.
- **No public sign-up.** An admin creates users. A new user gets a one-time activation code/link (expiring) to set their password. An admin can also reset a password (issues a new one-time code). Email/SMS delivery is not built yet: define a notification sender interface and a development implementation that logs the code; show the code to the admin in the API response in development only.
- **Login identifiers:** email **or** phone number **or** username (field workers may not have email). Each unique within the organization.
- **Passwords:** argon2id hashing, a sensible minimum policy, never logged or returned.
- **Sessions:** short-lived access token plus rotating refresh tokens, stored hashed in the database with device info, revocable. Reuse of a rotated refresh token revokes that whole session family.
  - Web: httpOnly, Secure (in production), SameSite cookies, with CSRF protection.
  - Mobile: tokens in Expo SecureStore, sent as a bearer header.
- **Logout** (current device) and **logout everywhere**. Archiving a user or removing their memberships revokes their sessions immediately.
- **Brute-force protection:** rate limiting on login, activation and reset endpoints, and temporary lockout after repeated failures. Generic error messages (don't reveal whether an account exists).
- **Audit** every security event: login success/failure, logout, activation, password reset, lockout, session revoked. Never store passwords, codes or tokens in audit or outbox rows.
- **Remove the `x-dev-user-id` header path** from the running app. Integration tests should authenticate through a test helper instead. Seed users get development passwords defined in the seed file only (never printed in chat output); document in README how to log in as each seeded role.
- All secrets (token signing keys, etc.) from environment variables, validated at boot; the API refuses to start in production with missing or default secrets.

## Permissions — the rules (decided)
Wire the Phase 2 scope-resolution service into a single authorization layer (guards/policies), not ad-hoc checks inside controllers. Every business route must declare its policy; add a test that fails if any route has none.

**Who sees which records**
- **Worker:** their own work logs; tasks assigned to them; the sites, teams, log types and basic profiles (name, role) of people they need to work with. Not other workers' logs.
- **Supervisor:** everything within their scope (the union of their sites and teams, including child sites/teams), plus their own records.
- **Manager:** the whole organization's operational data.
- **Admin:** everything, including user, membership and organization settings.
A user with several memberships gets the union of what each grants.

**Who can set what (per-field rules)**
- The server always sets `authorId` / `createdById` from the logged-in user. Clients cannot set or change them.
- A worker can create and edit their own work logs, and edit only within a limited window (make it configurable per organization, default 24 h) and only while not approved.
- Only a supervisor or higher, within their scope, can approve or reject a work log. A user can never approve their own log.
- Workers can change the status of tasks assigned to them (e.g. to `in_progress`, `blocked`, `done`) but not reassign, re-scope or delete them. Supervisors create and assign tasks within their scope; managers and admins org-wide.
- Only admins manage users, memberships, roles, organization settings and log types (managers may manage log types if you see a clear reason; justify it in the ADR).
- No one can grant a role or scope higher than their own.

**Audit log and event feed**
- Audit events: readable by admins only, filtered to their organization.
- Outbox events: internal only. No route in production; keep a development/test-only route if useful, guarded the same way as before.
- Both contain personal data (emails, GPS); confirm redaction rules from Phase 2 still apply.

**Responses** must only include fields the caller may see (e.g. a worker seeing a colleague's profile gets name and role, not email/phone). Use explicit response shapes per role level rather than returning full database rows.

Return 404 (not 403) for records outside the caller's scope, so their existence isn't revealed; 403 for visible records the caller can't modify. Document this.

## Clients (minimal, only what's needed to use login)
- packages/shared: auth API client functions and Zod schemas; the typed API client handles token refresh and 401s once (no infinite retry loops).
- apps/web: HZ-branded login page, activation/set-password page, logout, and route protection (unauthenticated users go to login). Show the logged-in user's name and role. No dashboard features yet.
- apps/mobile: HZ-branded login and activation screens, secure token storage, logout, and a placeholder home screen showing the user's name and role. No work-logging screens yet (Phase 4).

## Out of scope
Feature screens, offline sync, file upload, AI, SSO/external providers, real email/SMS sending. Don't build them.

## Before building
Per AGENTS.md, first state: business objective, expected behavior, components affected, data required, external integrations, failure cases, test plan. Include a permissions matrix (roles × resources × actions) in ARCHITECTURE.md, and write ADR-0004 (authentication) and ADR-0005 (authorization model and the 404-vs-403 rule). Then proceed without waiting for approval.

## Subagents
- Run in parallel: one subagent for authentication (tokens, sessions, activation, reset, rate limiting), one for the authorization layer and per-route policies, one for the web and mobile login flows.
- Use the project `test-writer` subagent for: every cell of the permissions matrix; a worker unable to see another worker's logs; a supervisor unable to see outside scope; multi-membership union; nobody approving their own log; no privilege escalation through memberships; server-set author fields ignored from client input; refresh-token rotation and reuse detection; lockout; archived user's sessions revoked; no route without a policy; no secrets or tokens in logs, audit or outbox.
- Then run the project `reviewer` subagent as an adversarial security reviewer against this prompt, AGENTS.md and OWASP API Top 10 (especially broken object-level and function-level authorization). Fix what it finds.
- Finally run `docs-keeper` to update MEMORY.md, ARCHITECTURE.md, ROADMAP.md (Phase 3 done-when criteria), ADRs, README and every touched folder's memory.md.

## When finished
- Run install, build, lint, typecheck, test, test:integration and format:check; apply migrations; run `pnpm db:reset`; confirm `pnpm dev` starts everything.
- Give me the end-of-change summary described in AGENTS.md.
- List exactly what I should test manually before Phase 4: logging in on the web as an admin, a supervisor and a worker; what each should and shouldn't see in Swagger; the activation flow for a new user; lockout; logout everywhere. Give PowerShell-friendly examples where useful.
- Do not commit; I will review and commit myself.
