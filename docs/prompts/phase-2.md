WORKING DIRECTORY: D:\Personal Projects\Huseyin\Operations_App

PHASE 2 of 8 — Backend core: flexible organization model, work data, audit log, event outbox, and HZ branding

## Start of session
Follow AGENTS.md: read AGENTS.md → MEMORY.md → ARCHITECTURE.md → ROADMAP.md → apps/api/memory.md, packages/shared/memory.md, apps/web/memory.md, apps/mobile/memory.md.

## Phase 1 status (verified manually by me on 2026-10-13)
- Docker and PostgreSQL run: `pnpm db:up` reports the container healthy.
- `GET http://localhost:3001/health` returns `{"status":"ok","database":"up",...}`.
- First commit is made on `main`.
- Not yet checked: the phone test (deferred to Phase 4, campus Wi-Fi blocks phone-to-PC traffic). The web status card showed "API unreachable" on first load while the API was still compiling; check that it recovers on "Check again" once the API is up, and fix it if it doesn't.
Update MEMORY.md's "Verified" / "Not yet verified" sections accordingly.

## Product and branding
- The client's product is called **HZ**. The app is the client's product, not Kaneri's. Kaneri.ai only builds and powers it.
- Logo files are in `docs/brand/` (`hz-logo.png` original 1254×1254, plus 1024, 512 and 192 px versions). Black background, gold "HZ" lettering, red swoosh, gold ring.
- Replace "Kaneri.ai / Operations App" branding in web and mobile with **HZ**: logo, app name, page title, favicon (web), app icon and splash (mobile, via app.json/app.config).
- Derive a small theme from the logo (black/near-black background, gold primary, red accent) as shared design tokens in `packages/shared` (or a new `packages/ui-tokens` if you judge it cleaner), used by both web and mobile. Check gold-on-black and text contrast meet WCAG AA.
- At most a small, unobtrusive "Powered by Kaneri.ai" in a footer/settings screen.
- Keep the client name configurable (environment/config), not hard-coded across components, because the same codebase may later be deployed for other clients.
- Update docs that say "Operations App" as the product name where appropriate (keep the folder name as is).

## Organization model — must be flexible
I don't yet know exactly how the client's company is organized. Different workers give input; the structure may change. Design so all of these work without schema changes:
- One **Organization** (tenant). Every business record carries `organizationId`, so the platform can host more clients later (multi-tenant-ready, single tenant used for now).
- **Sites** (physical locations/projects) and **Teams** (groups of people), both optional and independent. A worker can belong to zero, one, or several teams and be assigned to zero, one, or several sites.
- **Memberships** link a user to the organization with a role (`worker`, `supervisor`, `manager`, `admin`) and a **scope**: whole organization, specific site(s), and/or specific team(s). A supervisor may supervise a team, a site, or both. A person may hold different roles in different scopes.
- Structures may be hierarchical later (e.g. sub-sites, departments): leave room for an optional `parentId` on Site and Team rather than hard-coding a flat structure.
- Soft-delete/archive (`archivedAt`) for users, sites and teams so history and audit stay intact.

Enforcement of permissions is Phase 3. In this phase, design the data and a single **scope-resolution service** (given a user, return which org/sites/teams/users they may see) with unit tests, so Phase 3 only wires it into auth and every route.

## Work data — also flexible
- **Task**: title, description, status (`todo`, `in_progress`, `blocked`, `done`, `cancelled`), priority, optional site/team, assignee(s), created by, due date, timestamps.
- **WorkLog** (a worker's entry): author, timestamp the work happened (`occurredAt`) separate from `createdAt`, optional task, site, team, free text, optional GPS location (lat/lng/accuracy), status, and a **client-generated id** (UUID) so Phase 5 offline sync can be idempotent.
- **Log types / templates** configurable per organization (e.g. "Inspection", "Delivery", "Material usage"), each defining custom fields (name, type: text/number/boolean/select/date, required, options). WorkLog stores custom field values validated against its type's definition. This is the main flexibility point: the client must be able to add new kinds of input without code changes.
- **Attachment** metadata only (file name, mime type, size, storage key, linked to WorkLog). Actual upload/storage is Phase 4; define a storage interface, no provider.
- Leave a nullable place for AI-derived data later (e.g. `source`: manual/voice/photo/ai, and an AI metadata JSON) without building any AI.

## Audit log and events (reusable platform components)
- **AuditEvent**: who (actor id or "system"), what action, which entity type and id, organization, before/after (or diff), timestamp, request/correlation id. Written for every create/update/archive through one service, not scattered calls. Append-only.
- **Domain event outbox**: when work data changes (log created, task status changed, etc.), write an event row in the same transaction. Phase 7's AI layer will consume these. Just write and expose them now; no consumer yet besides a test.
- Put audit and outbox in modules designed to be reusable across Kaneri products (no HZ-specific logic in them).

## API
- REST endpoints for: organization (read/update settings), users, memberships, sites, teams, log types, tasks, work logs, attachments (metadata), audit events (read, filtered), outbox events (read, for internal/testing).
- Validation with Zod schemas from `packages/shared`, shared by API, web and mobile. Consistent error format, pagination, filtering (by site, team, user, date range, status), and sorting.
- Unify the health client in `packages/shared` (the open item from Phase 1) and create the general typed API client pattern the web and mobile apps will use.
- **No real authentication yet** (Phase 3). For development only, accept the acting user via a clearly marked dev header (e.g. `x-dev-user-id`), enabled only when `NODE_ENV=development` and an explicit env flag is set, so audit records have an actor. It must be impossible to enable in production, and documented as temporary in ARCHITECTURE.md and MEMORY.md.
- OpenAPI/Swagger docs generated from the API, available in development.

## Database
- Prisma models and migrations for everything above, with sensible indexes (organizationId on everything, plus common filters) and foreign keys.
- A **seed script** with realistic demo data: one organization ("HZ Demo"), 2 sites, 3 teams, ~10 users across all roles including a worker in two teams and a supervisor scoped to a site, 3 log types with custom fields, tasks and work logs over the past 2 weeks. Command: `pnpm db:seed`, plus `pnpm db:reset` (drop, migrate, seed) for development.

## Out of scope for this phase
Login/auth, permission enforcement on routes (only the scope service), real file upload, mobile/web feature screens beyond branding, offline sync, AI features. Don't build them.

## Before building
Per AGENTS.md, first state: business objective, expected behavior, components affected, data required, external integrations, failure cases, test plan. Then post the proposed data model (Mermaid ER diagram) and proceed without waiting for approval, but record it in ARCHITECTURE.md and write ADR-0002 (flexible organization and scope model) and ADR-0003 (configurable log types with custom fields), with tradeoffs (e.g. JSON custom fields vs EAV tables).

## Subagents
- After the data model is written, run in parallel: one subagent for the API modules (org structure, tasks, work logs, log types), one for the audit + outbox platform modules, one for HZ branding in web and mobile plus design tokens.
- Use the project `test-writer` subagent for: scope-resolution service (all membership combinations, including multi-team workers and site+team supervisors), custom field validation, audit and outbox written in the same transaction, dev-header guard being impossible to enable in production, and API integration tests against a test database.
- At the end, run the project `reviewer` subagent against this prompt and AGENTS.md; fix what it finds.
- Finally run `docs-keeper` to update MEMORY.md, ARCHITECTURE.md, ROADMAP.md (Phase 2 done-when criteria), ADRs, and every touched folder's memory.md.

## When finished
- Run install, build, lint, typecheck, test and format:check, apply migrations, run the seed, and confirm `pnpm dev` starts everything with the HZ branding.
- Give me the end-of-change summary described in AGENTS.md.
- List exactly what I should test manually before Phase 3, including example requests (PowerShell-friendly) to create a work log and see the matching audit and outbox events, and the URL of the Swagger docs.
- Do not commit; I will review and commit myself.
