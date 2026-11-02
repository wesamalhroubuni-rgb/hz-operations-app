# apps/web memory

Package `@ops/web`. Last updated: 2026-11-02.

## Purpose

The manager dashboard: a web app where supervisors, managers, and admins monitor and manage the
work that workers log. Built with Next.js (App Router) and React. The architecture is in
[ADR-0009](../../docs/decisions/0009-web-dashboard-architecture.md); the AI screens follow
[ADR-0011](../../docs/decisions/0011-daily-summaries-and-anomaly-rules.md).

## Current state

Phase 6 committed (`713f592`). Phase 7 (2026-10-30 to 2026-11-02) added the AI screens (below);
code complete, tested, reviewed, about to be committed. **Not yet used in a browser with data**
(it needs the owner's `pnpm db:reset`); only a smoke test in Phase 6. The browser steps are in
the combined manual test in `docs/reports/phase-7.md`.

- **Phase 7 (AI)**, in `src/components/ai/`, `src/lib/ai.ts`, `src/i18n/en/ai.ts`:
  - Overview: when `aiFeatures.dailySummary` is on, `LatestSummaryPanel` (the caller's latest
    summary: narrative as plain text, labelled AI-written when `narrativeSource` is `ai`, the key
    numbers from `stats`, its flags with reasons) and `AnomalyPanel` (`GET /ai/anomalies` for the
    day range ending at the shown day).
  - `/summaries` (supervisor and up, capability `readSummaries`): own summary history
    (`GET /ai/summaries`, `GET /ai/summaries/:id`).
  - `/ai-usage` (admin, capability `viewAiUsage`): calls, outcomes, tokens, estimated cost per
    day, feature, provider, model; today against the limits (`GET /ai/usage`).
  - Settings: `AiSettingsSection` (admins) with its own form and Save: the two switches, summary
    time, recipient roles, daily request and cost limits; the body keeps every other stored
    setting (`PATCH /organization` replaces the settings object).
  - No button for `POST /ai/summaries/generate` (an admin calls it from Swagger or a script).

- **Public pages** (Phase 3): `/login` (email, phone, or username plus password; signed-in users go
  to `?next=`, sanitised, or `/`) and `/activate` (activation and reset with a one-time code; a
  `?code=` is pre-filled and removed from the address bar; `no-referrer`, `no-store`).
- **Dashboard** (`src/app/(dashboard)/`, inside `AppShell`):

  | Route                   | Roles                      | What it does                                                                                                                                               |
  | ----------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `/`                     | supervisor, manager, admin | Overview: today's logs, awaiting my approval (`excludeOwn`), open, overdue, blocked tasks, per site and team, idle workers; each number links to its list. |
  | `/work-logs`            | supervisor, manager, admin | Table with filters (site, team, worker, log type, status, days, photos, search), sort, paging in the URL; bulk approve or reject; CSV export.              |
  | `/work-logs/[id]`       | supervisor, manager, admin | Custom fields, photo gallery (signed URLs, lightbox), location map, offline facts and clock warning, history, approve or reject with a note.               |
  | `/work-logs/report`     | supervisor, manager, admin | Printable report for up to 92 days (`@media print`).                                                                                                       |
  | `/map`                  | supervisor, manager, admin | Recent located logs (Leaflet), also listed as text.                                                                                                        |
  | `/tasks`, `/tasks/[id]` | supervisor, manager, admin | List and board by status; create, edit, assign, status with reason and version check; history; CSV export.                                                 |
  | `/people`               | manager (read only), admin | Invite (activation code shown once), reset code, archive and restore, memberships and scope, sessions and sign-out everywhere, language.                   |
  | `/structure`            | manager, admin             | Sites and teams as trees; log types with the custom-field editor (saved keys locked, a saved key cannot be reused; saving raises the version).             |
  | `/audit`                | admin                      | Audit log with filters, paging, and the redacted diff and offline facts.                                                                                   |
  | `/settings`             | admin                      | Organization name, time zone, edit window, offline backdating limit (sends every settings key); the AI section (Phase 7); the API status card.             |
  | `/summaries`            | supervisor, manager, admin | Own daily summaries, newest first, with detail (Phase 7).                                                                                                  |
  | `/ai-usage`             | admin                      | AI usage and limits (Phase 7).                                                                                                                             |

- **Shell** (`src/components/shell/`): navigation by role from `src/lib/navigation.ts` and
  `src/lib/permissions.ts` (mirrors the API policy registry; UX only), organization name and time
  zone, the account menu (`user-menu.tsx`: name, role, sign out, sign out everywhere), skip link,
  "Powered by Kaneri.ai". A worker sees "use the mobile app". Pages render only after the
  organization (and so its time zone) has loaded (`orgTimeGate` in `src/lib/time.ts`).
- **Session**: `createAuthSessionManager({ mode: 'web' })` from `@ops/shared`; httpOnly cookies
  the page cannot read, the CSRF token in memory only, `GET /auth/me` on load, one refresh on a 401. Nothing in `localStorage` or `sessionStorage`. The query cache is cleared when nobody is
  signed in.
- **Security headers** (`next.config.ts`): `X-Frame-Options: DENY`, CSP limited to
  `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, `nosniff`,
  referrer and permissions policies, HSTS in production, `poweredByHeader: false`. No
  `default-src`, `script-src`, `style-src`, `img-src`, or `connect-src`: the hosts a Phase 8
  nonce-based policy must allow (tiles, storage, API) are listed in the comment there.
- **Tests**: 191 unit tests in 12 files (2026-11-02, re-run by the docs-keeper), all in
  `src/**/*.test.ts` (Vitest, `node` environment): `src/lib/*.test.ts` (Phase 7 added
  `ai.test.ts`), `src/lib/work-logs/work-logs.test.ts`, and
  `src/components/manage/screens.render.test.ts` (renders management screens to a string).
- Not built: photo upload from the browser (deferred to Phase 8: a CORS rule on the bucket);
  catalogues other than English; restoring archived log types (no API route).

## Key files

| File or folder                                           | What it does                                                                                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/layout.tsx`                                     | Root layout: brand metadata, theme tokens on `<html>`, `lang` / `dir` from `LOCALE`, `AuthProvider`, `QueryProvider`.                                                                                     |
| `src/app/(dashboard)/layout.tsx`                         | Wraps every dashboard page in `AppShell`.                                                                                                                                                                 |
| `src/components/query-provider.tsx`                      | The TanStack Query client with the defaults of `src/lib/api/query.ts`.                                                                                                                                    |
| `src/components/auth-provider.tsx`                       | Subscribes to the session manager, `RouteGuard`, `useAuth()`.                                                                                                                                             |
| `src/components/ui/`                                     | DataTable, Pagination, filters, Loading/Empty/ErrorState, dialogs (`<dialog>`), form controls, StatusBadge, layout.                                                                                       |
| `src/components/<area>/`                                 | One folder per page area: `overview`, `work-logs`, `tasks`, `map-page`, `report`, `exports`, `people`, `structure`, `audit`, `settings`, `manage` (shared parts of the admin screens), `ai` (Phase 7).    |
| `src/lib/ai.ts`                                          | AI settings form state and body, summary and anomaly display helpers, `AI_USAGE_PATH` (tested in `ai.test.ts`).                                                                                           |
| `src/components/map/`                                    | `map-view.tsx` loads `leaflet-map.tsx` with `next/dynamic` (`ssr: false`).                                                                                                                                |
| `src/hooks/`                                             | `use-caller` (role, capabilities), `use-organization`, `use-directory`, `use-list-params`, `use-work-logs`, sign-in and sign-out hooks.                                                                   |
| `src/lib/api/client.ts`, `api/query.ts`, `api/errors.ts` | `authSession` and `apiClient` (null without an API URL); `queryKeys`, `unwrap`, retry rules; error to message mapping.                                                                                    |
| `src/lib/list-params.ts`                                 | URL list state: parse and write filters, sort, page (a filter change resets to page 1).                                                                                                                   |
| `src/lib/time.ts`                                        | `createOrgTime` / `useOrgTime`, `orgTimeGate`, day ranges over the shared time-zone helpers.                                                                                                              |
| `src/lib/permissions.ts`, `navigation.ts`                | Capabilities per role; routes, navigation, and route access.                                                                                                                                              |
| `src/lib/log-type-editor.ts`                             | The custom-field editor's logic (locked saved keys, `keyReused`, choices, order, validation).                                                                                                             |
| `src/lib/` (others)                                      | `directory.ts`, `download.ts` (`saveTextFile` re-adds the CSV BOM), `exports.ts`, `map.ts`, `overview.ts`, `report.ts`, `tasks.ts`, `people.ts`, `structure.ts`, `settings.ts`, `audit.ts`, `work-logs/`. |
| `src/i18n/index.ts`, `src/i18n/en/*.ts`                  | `t()` over the shared translator; English catalogue, one file per namespace.                                                                                                                              |
| `src/lib/env.ts`                                         | The only place that reads environment variables.                                                                                                                                                          |
| `src/lib/brand.ts`                                       | Name, app label, logo, "Powered by Kaneri.ai".                                                                                                                                                            |
| `scripts/next.mjs`                                       | Copies `WEB_PORT` to `PORT`, then runs the Next.js CLI.                                                                                                                                                   |
| `next.config.ts`                                         | Strict mode, `agentRules: false`, monorepo root, `poweredByHeader: false`, security headers.                                                                                                              |

`next-env.d.ts` and `.next/` are generated and git-ignored.

## Dependencies

Next.js `~16.4.3` (16.4.0 to 16.4.3 on 2026-10-28 after a security notice; `eslint-config-next`
the same), React and React DOM exactly `19.2.3` (same as mobile), `@tanstack/react-query` 5.104.3
(the mobile app's version), `@tanstack/react-table` 8.21.3, `leaflet` 1.9.4, `react-leaflet`
5.0.0, `@types/leaflet` 1.9.22, `zod`.

## Environment variables

| Variable                        | Used by            | Notes                                                                                      |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `WEB_PORT`                      | `scripts/next.mjs` | Port for `dev` and `start`. On the owner's PC 3000 is taken: use for example 3100.         |
| `NEXT_PUBLIC_API_URL`           | `src/lib/env.ts`   | Must be an `http` or `https` URL. Inlined at build time.                                   |
| `NEXT_PUBLIC_BRAND_NAME`        | `src/lib/env.ts`   | Product name. Falls back to "Operations". Inlined at build time.                           |
| `NEXT_PUBLIC_ORGANIZATION_SLUG` | `src/lib/env.ts`   | Sent with every sign-in (`hz-demo`).                                                       |
| `NEXT_PUBLIC_MAP_TILE_URL`      | `src/lib/env.ts`   | Optional tile template with `{z}`; anything else (or empty) means the OpenStreetMap tiles. |

The API side must match: `CORS_ORIGINS` must contain the exact origin the dashboard is opened
from (also when `WEB_PORT` changes), and `WEB_APP_URL` is where activation links point.

## Scripts

Run from the repo root as `pnpm --filter @ops/web <script>`.

| Script      | Command                                            |
| ----------- | -------------------------------------------------- |
| `dev`       | `node scripts/next.mjs dev` with the root `.env`   |
| `build`     | `node scripts/next.mjs build` with the root `.env` |
| `start`     | `node scripts/next.mjs start` with the root `.env` |
| `lint`      | `eslint .`                                         |
| `typecheck` | `next typegen`, then `tsc --noEmit`                |
| `test`      | `vitest run`                                       |

## Conventions

- `src/app/` is routing and layout; `src/components/` UI; `src/hooks/` connects logic to React;
  `src/lib/` is logic with no React in it, and that is where tests go.
- **Every API call goes through `apiClient`**, in TanStack Query hooks with keys from
  `queryKeys`; mutations wait for the server and invalidate the affected keys (optimistic only
  where a refusal cannot surprise). No global state library.
- **List state lives in the URL** with the API's query parameter names (`useListParams`); a new
  filter goes into the shared filter shape first, so list, export, and links get it together.
- **Every user-facing string through `t('...')`.** Add keys to your page's file in
  `src/i18n/en/`; `core.ts` only for shared words. Never use a plural category name (`zero`,
  `one`, `two`, `few`, `many`, `other`) as a plain key: an object holding `other` is read as
  plural forms.
- **Logical CSS only** (`margin-inline-start`, `padding-inline`, `inset-inline-end`,
  `text-align: start`); never `left` / `right`. Never write a colour, spacing, radius, or font
  size: use the CSS variables from the tokens. The brand red is decoration, not text.
- **Times only through `useOrgTime()`**, day filters only through `zonedDaysRange`: the
  organization's zone, never the browser's.
- Leaflet is client-only: import it only inside `src/components/map/` behind `next/dynamic`.
- Accessibility: native elements first (`<dialog>`, `<select>`, `<table>` with caption and
  `aria-sort`), labels through `FormField`, status never by colour alone, one `<h1>` per page.
- Buttons for actions the role may not take are not offered (or disabled with a reason); the API
  still decides (404 shown as "not found or you cannot see it", 409 `version_conflict` as
  "reload and try again").
- **Never store a token in the browser**; never read the session cookies.
- AI text (summary narratives) is rendered as plain text only (no HTML, no Markdown links) and
  labelled AI-written; numbers shown next to it come from `stats`, not from the narrative.
- Never write a client name in a component; read `brand`. Read environment variables only in
  `src/lib/env.ts`, written out in full (Next.js inlines them by exact text).
- Import from `src` with the `@/` alias. Components are server components unless they need state
  or browser APIs.

## Known issues

- Not yet used in a browser with data; loading, empty, and error states, phone widths, and
  keyboard use have not been checked by a person. The Phase 7 panels and pages have never shown
  a real summary.
- The Summaries and AI usage entries are shown by role, also while the AI features are off (the
  pages then show no summaries or zero usage).
- The API status card (`src/components/api-status.tsx`, `hooks/use-api-health.ts`) is shown on
  the Settings page (admin) since Phase 6 (2026-10-28); the health texts themselves come from `@ops/shared`
  in English. The Phase 3 session card was removed (the user menu replaces it).
- A 403 from `POST /auth/login` means the page's origin is not in `CORS_ORIGINS`.
- No nonce-based CSP yet; in production the web app and the API must be same-site (or
  `AUTH_COOKIE_DOMAIN` set) and on HTTPS.
- The dashboard language is fixed to English (`LOCALE`); per-user selection comes with a second
  catalogue.
- The public OpenStreetMap tiles are for development and light use only; set
  `NEXT_PUBLIC_MAP_TILE_URL` before production.
- `NEXT_PUBLIC_*` values are inlined at build and dev-server start; restart after changing them.
- `typecheck` runs `next typegen` first; `agentRules: false` must stay in `next.config.ts`.
- The `description` in `package.json` still says "Operations App".
