# Phase 6 report: web manager dashboard

Date: 2026-10-28. Specification: [docs/prompts/phase-6.md](../prompts/phase-6.md). Decision record:
[ADR-0009](../decisions/0009-web-dashboard-architecture.md) (business objective, expected
behaviour, components, data, integrations, failure cases, test plan, and the full endpoint
contract).

## 1. What changed

- **Web (`apps/web`)**: the dashboard, behind sign-in, with an app shell (navigation by role,
  organization name and time zone, user menu, "Powered by Kaneri.ai" footer).
  - **Overview** (`/`): today's logs, logs awaiting the caller's approval, open, overdue and
    blocked tasks, activity per site and team, workers with no activity today. Every number links
    to the filtered list and equals its total.
  - **Work logs**: table with filters (site, team, worker, log type, status, date range, has
    photos, search), sorting, pagination, all in the URL; bulk approve or reject with per-item
    results. Detail: custom fields, photo gallery (signed URLs, lightbox), location map, offline
    facts (submitted offline, phone clock, skew warning), history, approve and reject with a note.
    Own logs cannot be approved, in the UI or on the server.
  - **Tasks**: list and board by status; create, edit, assign, reassign, cancel with a reason,
    status changes with version checks; blocked reasons; history.
  - **Map**: recent located logs on OpenStreetMap (Leaflet), with links to the detail.
  - **People** (admin manages, managers view): invite with an activation code shown once, password
    reset code shown once, archive and restore, memberships (role and scope), sessions and "sign
    out everywhere", language.
  - **Structure**: sites and teams as a tree, log types with a custom-field editor (add, reorder,
    remove, required, choices); saved field keys are locked; saving raises the version.
  - **Audit log** (admin): filters, paging, detail with the redacted diff and offline-sync facts.
  - **Exports and report**: CSV of the filtered work logs and tasks; a printable report for a date
    range.
  - **Settings** (admin): organization name, time zone, edit window, offline backdating limit.
  - i18n layer with one catalogue file per area (English; Turkish and Arabic fall back to English),
    logical CSS only (right-to-left ready), times in the organization's time zone everywhere.
- **API (`apps/api`)**: `GET /dashboard/overview`, `GET /directory`, `GET /work-logs/map`,
  `POST /work-logs/bulk-status`, `GET /work-logs/:id/history`, `GET /tasks/:id/history`,
  `GET /exports/work-logs.csv`, `GET /exports/tasks.csv`, `GET /reports/work-logs`,
  `GET /users/:id/sessions`, `POST /users/:id/sessions/revoke`; new list filters (`search`,
  `hasPhotos`, `excludeOwn`, `open`, `overdue`, more sorts); six new policies for supervisor,
  manager and admin; the organization time zone setting; a language per user (`User.locale`) and
  notifications rendered in the recipient's language. Exports are audited (filters and row count),
  capped at 10,000 rows, and safe against spreadsheet formula injection. Migration
  `20261028090000_phase6_dashboard`.
- **Shared (`@ops/shared`)**: the schemas and endpoints above, time-zone helpers, CSV helpers, the
  translation core (now shared by web and mobile).
- Next.js updated from 16.4.0 to 16.4.3 (within the `~16.4` pin) after a security notice in the
  build.

## 2. Why

Supervisors, managers and admins need to run the operation from a laptop: see what happens, assign
work, review logs, and manage the organization, strictly within their Phase 3 scope.

## 3. Files

`git show --stat` on the Phase 6 commit has the full list. Main areas: `apps/web/src/app/(dashboard)`,
`apps/web/src/components/*`, `apps/web/src/lib/*`, `apps/web/src/i18n/en/*`,
`apps/api/src/operations/{dashboard,exports,reports,history}`, `packages/shared/src/domain/*`.

## 4. Architectural decisions (ADR-0009)

- TanStack Query for data, TanStack Table (headless) with list state in the URL, no global state
  library; Leaflet with OpenStreetMap tiles, loaded only in the browser (`NEXT_PUBLIC_MAP_TILE_URL`
  for another tile server in production).
- One filter builder per resource on the server, used by the list, map, export, report and
  overview, so the numbers always match the lists.
- The organization time zone lives in the settings (default `Europe/Istanbul`); the shell renders
  pages only once it is known.
- Judgment calls taken (recommended options): the API accepts a changed log-type field key (a
  rename cannot be told apart from remove plus add), while the editor locks saved keys and refuses
  reusing one; browser photo upload is deferred (not required by the prompt; it needs a CORS rule
  on the bucket); no image rule added to the Content-Security-Policy yet, because it would block
  the signed photo URLs.

## 5. Tests performed

- `pnpm build`, `lint`, `typecheck`, `test`, `test:integration`, `format:check` pass.
- Unit tests: API 527, shared 743, web 174, mobile 305. Integration tests: 1,534 in 21 suites.
- Covered: scope for supervisor, manager and admin on every data source, including changed ids and
  query parameters (no data leaks; foreign records 404); no self-approval, single and bulk;
  exports equal the lists and are audited; log-type versioning; CSV injection through a strict
  parser and over HTTP; time zones (half-hour offsets, daylight-saving days, the org "today");
  languages per user with English fallback; sessions admin only.
- Independent review: "pass with fixes", nothing blocking. Fixed: a photo refetch loop when the
  storage is unreachable; formatting; the "unknown place" label; "awaiting approval" counted the
  caller's own logs; reuse of a saved field key; pages briefly using the default time zone; left
  and right CSS on the sign-in pages; dead code (the unused Phase 3 session card removed; the API
  status card moved to the Settings page).

## 6. Limitations and next steps

- **Not yet seen in a browser with data**: it needs the owner's `pnpm db:reset`. Smoke-tested only
  (every route answers, security headers present).
- On this PC port 3000 is used by another project: set `WEB_PORT=3100` and add
  `http://localhost:3100` to `CORS_ORIGINS` and `WEB_APP_URL` in `.env` (README).
- Turkish and Arabic catalogues are not written yet (English fallback).
- Log types cannot be restored once archived (no API route).
- Requiring a site or team for worker and supervisor memberships is a UI rule only.

## Manual test (browser)

Sign-in identifiers are in README section 4 (passwords: `DEV_PASSWORDS` in the seed file).

As **aylin** (admin):

1. Overview: numbers load; click "awaiting approval" and check the list shows the same count.
2. Work logs: filter by site and date range, sort, page; reload the page and the filters stay.
   Open a log with photos: gallery, map, history. Approve one with a note. Select several
   submitted logs and bulk approve; your own logs cannot be selected.
3. Export CSV of the filtered list; open it in Excel (accents and Turkish letters correct). Open
   the printable report and print preview.
4. Tasks: switch to the board; create a task for a site, assign `deniz`, change its priority,
   block it with a reason, then cancel it with a reason.
5. People: invite a new user (the activation code shows once), reset a password (code shows
   once), view a user's sessions and sign them out everywhere, change a membership's scope.
6. Structure: add a team under another team; edit a log type (add a field, move it, make it
   required, add choices) and save: the version goes up.
7. Audit log: filter by action and date; open an event.
8. Settings: change the time zone; times on the Overview and lists change accordingly.

As **selin** (supervisor, site North Depot):

9. Overview and lists show only North Depot data. Change `siteId` in the URL to another site: the
   list is empty. Open a Harbour Project log by its URL: "not found".
10. No People, Structure, Audit log, or Settings in the navigation. Your own log cannot be
    approved (buttons disabled with a reason).

As **murat** (manager):

11. Sees the whole organization; People and Structure are visible; no Audit log or Settings; can
    export and use the map.
