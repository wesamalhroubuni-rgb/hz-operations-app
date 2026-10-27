WORKING DIRECTORY: the repository root you are running in (state it at the start).

PHASE 6 of 8 — Web manager dashboard

## Start of session
Follow AGENTS.md: read AGENTS.md → MEMORY.md → ARCHITECTURE.md → ROADMAP.md → all ADRs → apps/web/memory.md, packages/shared/memory.md, apps/api/memory.md. Confirm a green start (build, lint, typecheck, test, test:integration); fix anything that fails first.

## Goal
Supervisors, managers and admins run the operation from a laptop: see what is happening, assign work, review and approve logs, and manage the organization. The dashboard must respect the Phase 3 permission rules exactly (a supervisor only sees their scope).

## Screens (HZ branding, design tokens from packages/shared)
- **App shell:** sign-in (exists), navigation, user menu, organization name, "Powered by Kaneri.ai" footer. Desktop-first, usable on a tablet.
- **Overview (home):** for the caller's scope — today's logs, open/overdue/blocked tasks, logs awaiting approval, activity per site/team, and workers with no activity today. Each number links to the filtered list.
- **Work logs:** table with filters (site, team, worker, log type, status, date range, has photos), sorting, pagination, search. Detail view with custom fields, photos (gallery via signed URLs), location on a small map, history from the audit trail, and approve / reject with a note. Bulk approve where safe. Never allow self-approval (server already enforces; reflect it in the UI).
- **Tasks:** list and board (by status) views, create/edit/assign within scope, due dates, priority, reassign, cancel; show blocked reasons.
- **Map view:** recent logs with locations on a map (use an open map such as OpenStreetMap/Leaflet unless you find a strong reason otherwise; no paid key required in development).
- **People (admin):** users, invite (activation code from Phase 3), reset password, archive, memberships (role + site/team scope). Managers can view.
- **Structure (admin, managers where Phase 3 allows):** sites, teams (with parent/child), log types with a custom-field editor (add/reorder/required/options) that versions definitions as Phase 2 designed.
- **Audit log (admin only):** searchable, filtered list.
- **Exports:** CSV export of filtered work logs and tasks (respecting scope), plus a simple printable report for a date range.
- **Settings (admin):** organization name and settings that exist in the API (edit window, offline occurredAt limit, etc.).

## Quality
- Data loading with caching and clear loading/empty/error states; optimistic updates only where safe.
- Accessible (keyboard navigation, labels, contrast), i18n layer like mobile (English now, Turkish/Arabic-ready, RTL-safe layout).
- Times shown in the organization's time zone; make the time zone an organization setting if it doesn't exist.
- Any new API endpoints (overview aggregates, exports, map data) follow the Phase 3 rules: declared policy, scope-filtered queries, role-shaped responses, audit on writes. Exports are audited.

## Out of scope
AI features (Phase 7), billing, multi-organization admin UI.

## Before building
State: business objective, expected behavior, components affected, data required, integrations, failure cases, test plan. Write ADR-0009 (dashboard architecture: data fetching, state, tables, maps). Then proceed without waiting for approval.

## Subagents
- In parallel after shared contracts are agreed: one for API additions (aggregates, exports, map data, settings), one for logs/approvals/map screens, one for tasks/people/structure/audit/settings screens.
- `test-writer`: scope correctness on every screen's data (supervisor vs manager vs admin), no self-approval, exports respect scope, log-type editor versioning, CSV escaping/injection safety, time-zone display.
- `reviewer`: against this prompt, AGENTS.md and Phase 3 security rules; fix findings.
- `docs-keeper`: MEMORY, ARCHITECTURE, ROADMAP (Phase 6 done-when), ADRs, README, folder memory files.

## When finished
Run all checks, give the end-of-change summary from AGENTS.md, and a short manual test list for the dashboard as aylin (admin), selin (supervisor) and a manager.
