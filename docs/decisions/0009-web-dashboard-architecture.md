# ADR-0009: Web dashboard architecture

- **Status**: Accepted
- **Date**: 2026-10-28
- **Phase**: 6

## Context

Phase 6 builds the manager dashboard (`docs/prompts/phase-6.md`): supervisors, managers and
admins see what is happening in their scope, review and approve work logs, assign tasks, and
manage the organization, from a laptop or a tablet. Until now the web app had only sign-in,
activation and a placeholder home page. The work is split between a foundation step (this ADR,
the shared contracts, the Prisma change and the web shell) and three agents working in parallel:
**A** (API additions), **B** (overview, work logs, map, exports, report screens) and **C** (tasks,
people, structure, audit, settings screens). The decisions below fix what they rely on.

### Before building (AGENTS.md statement)

1. **Business objective.** Supervisors and managers run the operation from the browser: see
   today's activity, act on the review queue, assign and follow tasks, and administer people and
   structure, without ever seeing data outside their scope.
2. **Expected behaviour.** Role-based navigation; an overview whose every number opens the
   filtered list it counts; work-log and task tables with filters, sorting, pagination and
   search held in the URL; a work-log detail with custom fields, photos, location and history;
   approve / reject (single and bulk) with a note, never self-approval; tasks as list and
   board; a map of recent located logs; CSV exports and a printable report of the same scope;
   people, structure (with the log-type field editor), audit log and settings for the roles that
   may use them. Times in the organization's time zone. Loading, empty and error states
   everywhere. Keyboard usable, labelled, RTL-safe.
3. **Components affected.** `@ops/shared` (new and extended contracts, time-zone, CSV and
   locale helpers, the translation core moved from mobile), `apps/api` (new routes and
   policies, `User.locale`, localised notifications), `apps/web` (everything visible),
   `apps/mobile` (only the re-export of the moved translation core and one catalogue key).
4. **Data required.** Existing tables only, plus `User.locale` and `settings.timeZone` in
   `Organization.settings`. Aggregates are computed on read; nothing is denormalised.
5. **External integrations.** OpenStreetMap tiles (no key) via Leaflet; signed MinIO/S3 photo
   URLs (existing). No paid service.
6. **Failure cases.** API down or slow (error state with retry, bounded retries); a record
   outside scope (404, shown as "Not found or you cannot see it"); an action the role may not
   take (403, buttons not offered in the first place); a stale version (409 `version_conflict`,
   "reload and try again"); an export over the row cap (422 `export_too_large`); a bulk review
   with some refusals (per-item results); an expired session mid-page (one refresh, then the
   sign-in page, cache cleared); tiles unreachable (the map is never the only way to the data);
   an invalid time zone in settings (validation refuses it; a stored bad value falls back to
   the default).
7. **Test plan.** Shared unit tests for every new schema, the time-zone helpers (Istanbul,
   DST in Berlin, day ranges) and CSV escaping and injection; web unit tests for capabilities,
   navigation, URL list state, org-time formatting, the directory index and error mapping;
   API integration tests (agent A, then `test-writer`) for each new route as supervisor vs
   manager vs admin (scope, role shape, 403/404), no self-approval in bulk, exports respecting
   scope and audited, histories redacted and role-shaped, log-type versioning through the
   editor's request, locale-rendered notifications; the matrix suite extended with the new
   policies; the reviewer's browser pass as aylin (admin), selin (supervisor) and a manager.

## Decision

### Data fetching and state

- **TanStack Query 5** (`@tanstack/react-query` 5.104.3, the mobile app's exact version) over
  the existing typed `apiClient` from `@ops/shared` (cookie session, CSRF header, refresh once on
  a 401). `unwrap(result)` turns an `ApiResult` into data or an `ApiCallError` for query
  functions. Defaults (`src/lib/api/query.ts`): `staleTime` 30 s, refetch on focus, retries
  only for network, timeout, 429 and 5xx (at most two), mutations never retried. Query keys come
  from one `queryKeys` factory so mutations invalidate exactly the affected lists. The cache is
  cleared whenever nobody is signed in.
- **No global state library.** Server state lives in the query cache; list state (filters,
  sort, page) lives in the URL; everything else is component state.
- **Optimistic updates only where a refusal cannot surprise** (for example marking a
  notification read). Approvals, assignments, edits and settings wait for the server's answer,
  then invalidate.

### Tables and list state

- **TanStack Table v8** (`@tanstack/react-table` 8.21.3, headless) in manual mode: sorting,
  filtering and pagination happen on the server. (v9 was published on 2026-10-12; v8 is the
  long-stable line the coordinator chose and is kept.)
- **The URL is the list state.** Query parameter names equal the API's list query names
  (`workLogFilterShape`, `taskFilterShape`, `page`, `pageSize`, `sort=field:dir`), so a filtered
  view is a shareable link, the back button works, the overview's `filter` objects open lists
  unchanged, and the same parameters feed the CSV export. Pure helpers in
  `src/lib/list-params.ts`, connected by `useListParams(filterKeys)`. Changing a filter, the sort
  or the page size resets to page 1.
- **Names behind ids** come from one cached call, `GET /directory` (visible users, sites, teams,
  log types; names only), instead of one request per row or embedding names in every list.

### Maps

- **Leaflet 1.9.4 + react-leaflet 5.0.0 with OpenStreetMap tiles**, loaded client-only
  (`next/dynamic`, `ssr: false`). Circle markers coloured from the design tokens (no marker
  images). The tile URL is configurable (`NEXT_PUBLIC_MAP_TILE_URL`, default OSM) because OSM's
  usage policy forbids heavy use; production sets its own provider.
- **CSP**: the current policy has no `default-src`, so tiles and signed photo URLs already load.
  Adding `img-src` now would also have to list the storage origin, which the web app does not
  know; the hosts to allow are recorded in `next.config.ts` for the Phase 8 nonce-based policy.
  (The coordinator suggested adding the tile host now; it is not needed and would break photos.)

### Internationalisation and RTL

- The translation core (`createTranslator`, plurals, `{{name}}`) **moved to `@ops/shared`**
  (`src/i18n/translate.ts`); the mobile app re-exports it unchanged. The web has its own
  catalogue in `apps/web/src/i18n/`, split into **one file per namespace** (`en/core.ts` for the
  foundation, one file per page namespace for the screen agents) so parallel work never edits
  the same file. Components call `t('key')`; no user-facing English in components.
- `SUPPORTED_LOCALES = ['en', 'tr', 'ar']` (`@ops/shared`), `User.locale` (default `en`),
  editable by the user themself and by admins; `<html lang dir>` comes from the locale. Only
  English catalogues exist; Turkish and Arabic fall back to English key by key (web, mobile and
  notifications alike).
- **RTL-safe CSS**: logical properties only (`margin-inline-start`, `padding-inline`,
  `inset-inline-end`, `border-inline-start`, `text-align: start`), never `left` / `right`.
- **Notifications** are rendered on the server in the recipient's `User.locale` through the
  existing catalogue (`notification-messages.ts`), English for now.

### Time zone

- `Organization.settings.timeZone` (IANA name, validated with `Intl`; default
  `Europe/Istanbul`), in the settings JSON next to `workLogEditWindowHours` and
  `offlineMaxBackdateDays`; the organization summary carries the value in force (`timeZone`).
- Pure helpers in `@ops/shared` (`common/time-zone.ts`, reusable by mobile and the API):
  `formatInTimeZone`, `zonedDayKey`, `zonedDayStart`, `zonedDaysRange` (whole local days to the
  inclusive/exclusive API range, DST-correct), `formatSortableInTimeZone` (exports),
  `timeZoneOf`. The web wraps them in `createOrgTime` / `useOrgTime()`. "Today" on the overview
  and every date filter are days in the organization's zone, never the browser's.

### Exports and reports

- `GET /exports/work-logs.csv` and `GET /exports/tasks.csv`: the list filters inside the
  caller's visibility; `text/csv; charset=utf-8` with a UTF-8 BOM; columns fixed in
  `WORK_LOG_EXPORT_COLUMNS` / `TASK_EXPORT_COLUMNS`; local times in the organization's zone plus
  UTC; at most `EXPORT_MAX_ROWS` (10,000) rows, else 422 `export_too_large`.
- **CSV injection**: `toCsv` / `csvCell` in `@ops/shared` (`common/csv.ts`, pure, tested). A
  text cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`; cells with a comma,
  quote or line break are quoted with doubled quotes; CRLF line ends. Shared, not API-only, so
  the rule has one definition and one test suite.
- **Every export is audited**: action `export.work_logs` / `export.tasks`, entity type
  `export`, a new id, `after` = `{ format: 'csv', filters, rowCount }`. Audit only, no outbox
  event (an export changes no business record). The API adds an audit-only method next to
  `ChangeRecorder.record` (agent A) rather than calling `AuditService` from a domain service.
- The web downloads through the `apiClient` (session, refresh, readable errors; the transport
  gained `responseType: 'text'`) and saves a Blob, re-adding the BOM that `Response.text()`
  strips (`saveTextFile`).
- **Printable report**: `GET /reports/work-logs` returns totals and groupings for a range of at
  most 92 days; the web page lays it out with `@media print`. No server-side PDF.

### Accessibility

Native elements first: `<dialog>` for modals and drawers (focus trap, Escape, inert page), native
`<select>`, `<input type="date">`, `<table>` with a caption and `aria-sort`, a skip link, one
`<h1>` per page, labels wired through `FormField` (`aria-describedby`, `aria-invalid`), status
never by colour alone, `prefers-reduced-motion` respected, token colours (contrast-checked in
`@ops/shared`). Every map point is also reachable as text.

### Route protection (UX only)

`src/lib/permissions.ts` mirrors the policy registry; `src/lib/navigation.ts` maps routes to the
capability they need; the app shell shows a "not available for your role" state, or "use the
mobile app" for workers. The API remains the only authority (ADR-0005).

## API contract (Phase 6)

All in `@ops/shared`; agent A implements them. New policies go into `policies.ts`, the
permissions matrix in ARCHITECTURE.md, and the matrix suite.

| Method and path                    | Policy (roles)                           | Request schema                                          | Response schema                                          |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `GET /dashboard/overview`          | `dashboard.read` (supervisor+) new       | `dashboardOverviewQuerySchema`                          | `dashboardOverviewSchema`                                |
| `GET /directory`                   | `directory.read` (supervisor+) new       | none                                                    | `directorySchema`                                        |
| `GET /work-logs` (extended)        | `work_log.read` (existing)               | `listWorkLogsQuerySchema`                               | `workLogListSchema` (items gain `attachmentCount`)       |
| `GET /work-logs/:id` (extended)    | `work_log.read` (existing)               | none                                                    | `workLogSchema` (with `attachmentCount`)                 |
| `POST /work-logs/bulk-status`      | `work_log.review` (supervisor+) new      | `bulkWorkLogStatusSchema`                               | `bulkWorkLogStatusResultSchema`                          |
| `GET /work-logs/map`               | `work_log.read` (existing)               | `workLogMapQuerySchema`                                 | `workLogMapSchema`                                       |
| `GET /work-logs/:id/history`       | `work_log.read` (existing)               | none                                                    | `recordHistorySchema`                                    |
| `GET /tasks` (extended)            | `task.read` (existing)                   | `listTasksQuerySchema`                                  | `taskListSchema`                                         |
| `GET /tasks/:id/history`           | `task.read` (existing)                   | none                                                    | `recordHistorySchema`                                    |
| `GET /exports/work-logs.csv`       | `export.work_logs` (supervisor+) new     | `exportWorkLogsQuerySchema`                             | CSV text                                                 |
| `GET /exports/tasks.csv`           | `export.tasks` (supervisor+) new         | `exportTasksQuerySchema`                                | CSV text                                                 |
| `GET /reports/work-logs`           | `report.read` (supervisor+) new          | `workLogReportQuerySchema`                              | `workLogReportSchema`                                    |
| `PATCH /organization` (extended)   | `organization.update` (existing)         | `updateOrganizationSchema`                              | `organizationFullSchema` (settings gain `timeZone`)      |
| `GET /organization` (extended)     | `organization.read` (existing)           | none                                                    | `organizationSchema` (summary gains `timeZone`)          |
| `POST /users` / `PATCH /users/:id` | `user.manage` / `user.update` (existing) | `createUserSchema` / `updateUserSchema` (gain `locale`) | `createdUserSchema` / `userFullSchema` (gain `locale`)   |
| `GET /users/:id/sessions`          | `user.manage` (existing)                 | none                                                    | `authSessionListSchema` (`current` always false)         |
| `POST /users/:id/sessions/revoke`  | `user.manage` (existing)                 | none                                                    | `revokedSessionsSchema`                                  |
| `GET /auth/me` (extended)          | authenticated                            | none                                                    | `meResponseSchema` (`user.locale`, optional on the wire) |

Rules every new route follows: the organization from the caller; every query through the
resource's visibility filter; role-shaped answers (history `actorName` only for users the caller
can see, directory users `basic` only); writes through the write pattern. Specifics:

- **Overview**: counts for the caller's visibility; `idleWorkers` are active users with the
  worker role among the caller's people (manager/admin: everyone) with no log `occurredAt` in the
  day; each number carries `filter` (list query parameters as strings). Refinements as built
  (2026-10-28): the caller is never in their own idle list; a `bySite` / `byTeam` row for a
  place the caller cannot see by itself (a team supervisor sees that team's logs at any site)
  keeps the id the logs already carry but has `name: null`; the row of records without a place
  (`id: null`) links the day filter only, since the lists have no "no site" filter.
- **Bulk review** refinement: an unexpected error on one item is reported as that item's 500
  `internal_error` (and logged) instead of failing the whole request.
- **History** refinement: a log's history includes only the attachment events of attachments
  the caller may see (a pending upload is the uploader's only).
- **List filters added**: work logs `search` (text, case-insensitive), `hasPhotos`, sort by
  `updatedAt` / `status`; tasks `open`, `overdue`. Search uses `search` (the existing
  convention), not `q`.
- **Bulk review**: at most 100 items; each item processed exactly like
  `PATCH /work-logs/:id/status` in its own transaction (own audit event and notification); the
  caller's own logs refused per item (403); always 200 with per-item results.
- **Map**: located, visible logs, newest first, default last 7 days, at most 1,000.
- **History**: the record's audit events (a log's also include its attachments'), oldest first,
  at most 200, `changes` limited to `WORK_LOG_HISTORY_FIELDS` / `TASK_HISTORY_FIELDS`, no
  `before`/`after`, no correlation id, `offline` flag only.
- **Sessions**: through `AuthAdminService` (new list method; `revokeUserSessions` exists), never a
  token; revoking removes the push tokens through the session-end hook.
- **Settings**: `settings` still replaces the whole object; the settings screen sends every key.
- **Log-type editor**: no new endpoint. `PATCH /log-types/:id { fields }` already replaces the
  field list and bumps `version` when it changes (ADR-0003); keys must stay stable (renaming a
  key is removing a field and adding another; old logs keep their values and their version).
  The editor never edits a key of a saved field.

## Web foundation (what the screen agents build on)

- Routes under `src/app/(dashboard)/` inside `AppShell` (navigation by role, organization name
  and time zone, account menu, "Powered by Kaneri.ai"); `/login` and `/activate` unchanged.
- Building blocks in `src/components/ui/`: `DataTable`, `Pagination`, `FilterBar`,
  `SelectFilter`, `SearchFilter`, `DateRangePicker`, `StatusBadge` / `Badge`, `LoadingState`,
  `EmptyState`, `ErrorState`, `Modal`, `Drawer`, `ConfirmDialog`, `FormField`, `Input`,
  `Textarea`, `Select`, `Checkbox`, `Button`, `ButtonLink`, `PageHeader`, `Toolbar`;
  `src/components/map/map-view.tsx` (`MapView`).
- Hooks: `useCaller` (role, capabilities, `canReview`), `useOrganization`, `useOrgTime`,
  `useDirectory`, `useListParams`. Logic: `src/lib/permissions.ts`, `navigation.ts`,
  `list-params.ts`, `time.ts`, `directory.ts`, `download.ts`, `map.ts`, `api/errors.ts`,
  `api/query.ts`.
- **Page ownership**: agent B owns `/` (overview), `/work-logs`, `/work-logs/[id]`,
  `/work-logs/report`, `/map`, the export buttons, and the catalogue files `overview`,
  `work-logs`, `map-page`, `report`, `csv-export`. Agent C owns `/tasks`, `/tasks/[id]` (list and
  board), `/people`, `/structure` (including the log-type editor), `/audit`, `/settings`, and the
  catalogue files `tasks`, `people`, `structure`, `audit`, `settings`. Shared files
  (`src/components/ui`, `src/lib`, `en/core.ts`, `query.ts`) change only for a bug or a
  generic need, in small additive edits; page-specific components live next to their page
  (`src/components/work-logs/`, `src/components/tasks/`, ...).

## As built (2026-10-28, after the test-writer and the review)

The screens replaced every placeholder page. Where the code settled a point the sections above
leave open, it is recorded here:

- **`excludeOwn`** (`workLogFilterShape`, `queryBooleanSchema`): a work-log list filter that
  leaves out the caller's own logs. The overview's "awaiting approval" number counts
  `status=submitted&excludeOwn=true` and links to the same list, so it no longer counts logs the
  caller may not approve.
- **Log-type field keys**: the API does **not** refuse a changed key (a rename cannot be told
  apart from removing a field and adding another). The editor (`src/lib/log-type-editor.ts`) locks
  the key of every saved field and refuses a new field that reuses a key of the stored definition
  (`keyReused`), so old values are never reinterpreted.
- **Time-zone gate**: `AppShell` renders a page only once the organization (and so its time zone)
  has loaded (`orgTimeGate` in `src/lib/time.ts`); before that it shows a loading or error state,
  never times in a guessed zone.
- **Language of the dashboard**: `<html lang dir>` comes from the fixed `LOCALE` (`en`, `ltr`) in
  `src/i18n/index.ts`. Choosing the catalogue from the signed-in user's `locale` is wired only
  when a second catalogue exists. Notifications already use the recipient's `User.locale`.
- **Photo upload from the browser is not built** (deferred to Phase 8): the phase prompt does not
  require it, and it needs a CORS rule on the bucket. The dashboard shows photos only.
- **Next.js** moved from 16.4.0 to 16.4.3 (inside the `~16.4` range) after a security notice in
  the build.

## Reasons

- TanStack Query is already the mobile app's choice; one mental model across clients, with
  caching, refetch on focus and invalidation that hand-written effects would reimplement badly.
- The URL as list state gives shareable, bookmarkable, back-button-safe views for free and
  makes the overview links and exports the same parameters, so they cannot disagree.
- Headless tables keep the design tokens and accessibility in our hands.
- Leaflet + OSM needs no key and no account, and the provider can be swapped by configuration.
- Pure helpers in `@ops/shared` (time zone, CSV, locale, translation) are tested once and reused
  by the API, the web and the phone.

## Tradeoffs

- One query per page plus the directory call; the directory is capped at 5,000 entries per kind
  (organizations beyond that need a search endpoint).
- Aggregates are computed on read: fine for one organization of this size, to be revisited with
  indexes or materialised counts if the overview gets slow.
- The CSP stays without `img-src` / `connect-src` until Phase 8.
- Exports are synchronous and capped; very large exports would need a background job.
- The dashboard is English only until catalogues are translated.

## Alternatives considered

- **SWR or hand-written fetch hooks**: fewer features, a second pattern next to mobile's.
- **A global store (Redux, Zustand)**: nothing to put in it that the query cache and URL do not
  hold.
- **AG Grid / MUI DataGrid**: heavy, their own styling, licence questions for the useful parts.
- **Mapbox / Google Maps**: need keys and billing.
- **Server-side PDF reports**: a headless browser or PDF library on the API for little gain over
  the browser's print.
- **Names embedded in list responses**: changes every list mapper and the offline cache shapes;
  one directory call is simpler and cached.
- **`Organization.timeZone` as a column**: the existing settings JSON already holds the other
  organization settings with validated keys; a column would split them.

## Consequences

- Agent A adds the policies `dashboard.read`, `directory.read`, `work_log.review`,
  `export.work_logs`, `export.tasks`, `report.read` (all supervisor, manager, admin), their
  routes, the matrix rows and suite, the audit-only export recording, the session list in
  `AuthAdminService`, the locale rules (`user.rules`: self may change own `displayName` and
  `locale`), and per-recipient notification locale.
- Screens show times only through `useOrgTime()` and filter days only through `zonedDaysRange`.
- A new list filter is added to the shared filter shape first, so list, export and links get it
  together.
- Revisit: the directory cap, synchronous exports, the CSP, and translated catalogues.
