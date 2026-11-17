# apps/web memory

Package `@ops/web`. Last updated: 2026-11-17.

## Purpose

The manager dashboard: a web app where supervisors, managers, and admins monitor and manage the
work that workers log. Built with Next.js (App Router) and React. The architecture is in
[ADR-0009](../../docs/decisions/0009-web-dashboard-architecture.md); the AI screens follow
[ADR-0011](../../docs/decisions/0011-daily-summaries-and-anomaly-rules.md) and
[ADR-0012](../../docs/decisions/0012-organization-ai-provider-keys.md) (own AI keys); the
languages follow [ADR-0015](../../docs/decisions/0015-interface-language-per-device.md).

## Current state

Phase 7 committed (`3bfad42`). The 2026-11-16 additions are in `644b773` (pushed); the redesign
(`2131bdf`) and Turkish and Arabic (`ffaa5d8`) were committed on 2026-11-17 and are not pushed
yet. **No person's browser session with data is recorded**: on 2026-11-17 the dashboard was only
checked with headless screenshots in light, dark, and Arabic. The browser steps are in the
combined manual test in `docs/reports/phase-7.md`.

**Running it on the owner's PC** (2026-11-17): open <http://127.0.0.1:3200>. The local `.env`
has `WEB_PORT=3200` and `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001` (another project listens on
port 3001 over IPv6, so `localhost:3001` can reach it instead of the API), and the API allows
`http://127.0.0.1:3200` and `http://localhost:3200`. The dashboard runs as a production build
(`pnpm --filter @ops/web build`, then `start`) because the dev server lagged (Turbopack watched
`node_modules/.pnpm-task-run-state-v1`); rebuild after every change.

- **Languages (2026-11-17, ADR-0015)**:
  - Catalogues: `src/i18n/en/`, `tr/`, `ar/` (one file per namespace each), assembled in
    `en.ts` / `tr.ts` / `ar.ts`; Turkish and Arabic are typed against English, so a missing key
    fails the typecheck; English is the per-key fallback.
  - `src/i18n/index.ts`: `t()`, `setLocale(locale)`, `currentLocale()`, `localeTag()`
    (`en-GB`, `tr-TR`, `ar-u-nu-latn`: Arabic with Latin digits), `direction()`, `formatNumber`.
    `LOCALE` / `DIRECTION` are only what the server writes into `<html>` (English, ltr).
  - `src/lib/language.ts` (tested in `language.test.ts`): preference `system` / `en` / `tr` /
    `ar`, `localStorage` key `hz.language` (never sent to the API; `system` removes it),
    `resolveLanguage` (browser languages, else English), `LANGUAGE_INIT_SCRIPT` (inline in the
    root layout with the theme script: sets `lang` and `dir` before the first paint),
    `applyLanguagePreference`, `subscribeLanguage`.
  - `src/components/language-gate.tsx` (`LanguageGate`, around everything in the root layout):
    renders nothing on the server, calls `setLocale` before its children render, remounts them
    when the language changes.
  - The choice: a Language section in the account menu (`shell/user-menu.tsx`) and pills on the
    sign-in and activation pages (`language-switch.tsx`). `src/lib/auth-text.ts` routes the shared
    sign-in wording (`AUTH_TEXT`, failure messages) through the catalogue; the Turkish and Arabic
    sentences come from `AUTH_TRANSLATIONS` in `@ops/shared`.
  - Fonts through `next/font/google` in `src/app/layout.tsx`: Inter (`latin`, `latin-ext`;
    `--font-sans`) and IBM Plex Sans Arabic (`--font-arabic`), downloaded at build time.
  - The browser-tab titles (`metadata` in the root layout) stay English.
- **Redesign (2026-11-17)**: a black dotted sidebar (`brandInk` tokens) with an icon per entry
  (`src/components/ui/icons.tsx`), the organization's name beside the logo and a gold marker on
  the current page; the logo blended into the black with `mix-blend-mode: lighten`
  (`shell.module.css`, `auth-shell.module.css`); a split sign-in page (`auth-shell.tsx`);
  shadows, hover lift, tinted badges, a focus glow; date filters wide enough for the full date,
  with preset pills; table dates on one line. "Powered by Kaneri.ai" was removed
  (`src/lib/brand.ts`; `brand.test.ts` now checks the brand names no builder).

- **2026-11-16 additions**:
  - Settings: `AiKeysSection` (`src/components/settings/ai-keys-section.tsx`, logic in
    `src/lib/ai-keys.ts`, tested in `ai-keys.test.ts`; texts under `keys` in
    `src/i18n/en/ai.ts`): per provider (Claude, OpenAI) the source in force, hint, model, an
    unreadable warning; paste a key, **Check and save** (`PUT /ai/keys/:provider`), **Remove
    key**; errors mapped to messages (invalid, no access to the model, unreachable, storage
    unavailable, format, too many checks). Query key `queryKeys.ai.keys`. `AiSettingsSection`
    gained **Claude model** and **Voice-note model** selects (`settings.ai.llmModel` /
    `sttModel`, empty = "Server's default").
  - Theme (`src/lib/theme.ts`, tested in `theme.test.ts`): `src/app/layout.tsx` writes
    `themeStylesheet()` (dark on `:root`; light under `prefers-color-scheme: light` unless
    `data-theme="dark"`, and on `data-theme="light"`) and the inline `THEME_INIT_SCRIPT`, which
    sets `data-theme` on `<html>` before the first paint. The account menu (`user-menu.tsx`)
    offers Theme: System / Dark / Light; the choice is kept in `localStorage` key `hz.theme`
    (never sent to the API; "System" removes it). A Phase 8 nonce CSP must allow the inline
    script.
  - The brand name is no longer written next to the logo in `AuthShell` and the sidebar (the
    logo shows it).

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
  | `/settings`             | admin                      | Organization name, time zone, edit window, offline backdating limit (sends every settings key); the AI section with models; Your AI keys; API status.      |
  | `/summaries`            | supervisor, manager, admin | Own daily summaries, newest first, with detail (Phase 7).                                                                                                  |
  | `/ai-usage`             | admin                      | AI usage and limits (Phase 7).                                                                                                                             |

- **Shell** (`src/components/shell/`): navigation by role from `src/lib/navigation.ts` and
  `src/lib/permissions.ts` (mirrors the API policy registry; UX only), organization name and time
  zone, the account menu (`user-menu.tsx`: name, role, Theme, Language, sign out, sign out
  everywhere), skip link. A worker sees "use the mobile app". Pages render only after the
  organization (and so its time zone) has loaded (`orgTimeGate` in `src/lib/time.ts`).
- **Session**: `createAuthSessionManager({ mode: 'web' })` from `@ops/shared`; httpOnly cookies
  the page cannot read, the CSRF token in memory only, `GET /auth/me` on load, one refresh on a 401. Nothing of the session in `localStorage` or `sessionStorage` (only the theme and language
  choices). The query cache is cleared when nobody is signed in.
- **Live updates** (2026-11-16, `src/lib/api/live.ts`): the query client's default
  `refetchInterval` (`liveRefetchInterval`) refetches the `dashboard`, `workLogs` (not
  `attachments`: signed URLs), `tasks`, `users`, and `memberships` queries every 15 s while the
  tab is visible (TanStack pauses it in a hidden tab), doubling up to 5 minutes while a query
  fails, and stopping after a 4xx other than 429. The overview no longer sets its own 60 s.
  `AuthProvider` re-checks the user (`refreshUser`) every 30 s while visible and on focus or
  visibility change (throttled to 15 s). The web has no notification list (notifications are
  shown on the phone only).
- **Security headers** (`next.config.ts`): `X-Frame-Options: DENY`, CSP limited to
  `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, `nosniff`,
  referrer and permissions policies, HSTS in production, `poweredByHeader: false`. No
  `default-src`, `script-src`, `style-src`, `img-src`, or `connect-src`: the hosts a Phase 8
  nonce-based policy must allow (tiles, storage, API) are listed in the comment there.
- **Tests**: 210 unit tests in 16 files (2026-11-17, re-run by the docs-keeper), all in
  `src/**/*.test.ts` (Vitest, `node` environment): `src/lib/*.test.ts` (Phase 7 added
  `ai.test.ts`; 2026-11-16 `ai-keys.test.ts`, `theme.test.ts`, and `api/live.test.ts`;
  2026-11-17 `language.test.ts`),
  `src/lib/work-logs/work-logs.test.ts`, and
  `src/components/manage/screens.render.test.ts` (renders management screens to a string).
- Not built: photo upload from the browser (deferred to Phase 8: a CORS rule on the bucket);
  restoring archived log types (no API route).

## Key files

| File or folder                                            | What it does                                                                                                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/layout.tsx`                                      | Root layout: brand metadata (English), both themes' tokens in a `<style>`, the theme and language init scripts, the fonts, `LanguageGate`, `AuthProvider`, `QueryProvider`.                               |
| `src/lib/theme.ts`                                        | Theme preference (System / Dark / Light), stylesheet, init script, `applyThemePreference`.                                                                                                                |
| `src/lib/language.ts`, `src/components/language-gate.tsx` | Language preference (System / English / Türkçe / العربية), init script, `applyLanguagePreference`; the gate that applies it before rendering (ADR-0015).                                                  |
| `src/components/language-switch.tsx`                      | The language pills on the sign-in and activation pages (inside `AuthShell`).                                                                                                                              |
| `src/lib/auth-text.ts`                                    | `translateAuthText`, `authFailureText`: the shared sign-in wording through the catalogue.                                                                                                                 |
| `src/components/ui/icons.tsx`                             | The sidebar's icons (2026-11-17).                                                                                                                                                                         |
| `src/app/(dashboard)/layout.tsx`                          | Wraps every dashboard page in `AppShell`.                                                                                                                                                                 |
| `src/components/query-provider.tsx`                       | The TanStack Query client with the defaults of `src/lib/api/query.ts`.                                                                                                                                    |
| `src/components/auth-provider.tsx`                        | Subscribes to the session manager, `RouteGuard`, `useAuth()`.                                                                                                                                             |
| `src/components/ui/`                                      | DataTable, Pagination, filters, Loading/Empty/ErrorState, dialogs (`<dialog>`), form controls, StatusBadge, layout.                                                                                       |
| `src/components/<area>/`                                  | One folder per page area: `overview`, `work-logs`, `tasks`, `map-page`, `report`, `exports`, `people`, `structure`, `audit`, `settings`, `manage` (shared parts of the admin screens), `ai` (Phase 7).    |
| `src/lib/ai.ts`                                           | AI settings form state and body (with the models), summary and anomaly display helpers, `AI_USAGE_PATH` (tested in `ai.test.ts`).                                                                         |
| `src/lib/ai-keys.ts`                                      | The AI keys card's logic: status text per source, error mapping (tested in `ai-keys.test.ts`).                                                                                                            |
| `src/lib/api/live.ts`                                     | `liveRefetchInterval` (15 s for live query roots, backoff, stop on 4xx) and `USER_RECHECK_MS` (30 s).                                                                                                     |
| `src/components/map/`                                     | `map-view.tsx` loads `leaflet-map.tsx` with `next/dynamic` (`ssr: false`).                                                                                                                                |
| `src/hooks/`                                              | `use-caller` (role, capabilities), `use-organization`, `use-directory`, `use-list-params`, `use-work-logs`, sign-in and sign-out hooks.                                                                   |
| `src/lib/api/client.ts`, `api/query.ts`, `api/errors.ts`  | `authSession` and `apiClient` (null without an API URL); `queryKeys`, `unwrap`, retry rules; error to message mapping.                                                                                    |
| `src/lib/list-params.ts`                                  | URL list state: parse and write filters, sort, page (a filter change resets to page 1).                                                                                                                   |
| `src/lib/time.ts`                                         | `createOrgTime` / `useOrgTime`, `orgTimeGate`, day ranges over the shared time-zone helpers.                                                                                                              |
| `src/lib/permissions.ts`, `navigation.ts`                 | Capabilities per role; routes, navigation, and route access.                                                                                                                                              |
| `src/lib/log-type-editor.ts`                              | The custom-field editor's logic (locked saved keys, `keyReused`, choices, order, validation).                                                                                                             |
| `src/lib/` (others)                                       | `directory.ts`, `download.ts` (`saveTextFile` re-adds the CSV BOM), `exports.ts`, `map.ts`, `overview.ts`, `report.ts`, `tasks.ts`, `people.ts`, `structure.ts`, `settings.ts`, `audit.ts`, `work-logs/`. |
| `src/i18n/index.ts`, `src/i18n/{en,tr,ar}/*.ts`           | `t()`, `setLocale`, `currentLocale`, `localeTag`, `direction` over the shared translator; English, Turkish, and Arabic catalogues, one file per namespace.                                                |
| `src/lib/env.ts`                                          | The only place that reads environment variables.                                                                                                                                                          |
| `src/lib/brand.ts`                                        | Name, app label, logo (no builder credit since 2026-11-17).                                                                                                                                               |
| `scripts/next.mjs`                                        | Copies `WEB_PORT` to `PORT`, then runs the Next.js CLI.                                                                                                                                                   |
| `next.config.ts`                                          | Strict mode, `agentRules: false`, monorepo root, `poweredByHeader: false`, security headers.                                                                                                              |

`next-env.d.ts` and `.next/` are generated and git-ignored.

## Dependencies

Next.js `~16.4.3` (16.4.0 to 16.4.3 on 2026-10-28 after a security notice; `eslint-config-next`
the same), React and React DOM exactly `19.2.3` (same as mobile), `@tanstack/react-query` 5.104.3
(the mobile app's version), `@tanstack/react-table` 8.21.3, `leaflet` 1.9.4, `react-leaflet`
5.0.0, `@types/leaflet` 1.9.22, `zod`.

## Environment variables

| Variable                        | Used by            | Notes                                                                                        |
| ------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `WEB_PORT`                      | `scripts/next.mjs` | Port for `dev` and `start`. On the owner's PC 3000 is taken: 3200 there.                     |
| `NEXT_PUBLIC_API_URL`           | `src/lib/env.ts`   | Must be an `http` or `https` URL. Inlined at build time. `127.0.0.1:3001` on the owner's PC. |
| `NEXT_PUBLIC_BRAND_NAME`        | `src/lib/env.ts`   | Product name. Falls back to "Operations". Inlined at build time.                             |
| `NEXT_PUBLIC_ORGANIZATION_SLUG` | `src/lib/env.ts`   | Sent with every sign-in (`hz-demo`).                                                         |
| `NEXT_PUBLIC_MAP_TILE_URL`      | `src/lib/env.ts`   | Optional tile template with `{z}`; anything else (or empty) means the OpenStreetMap tiles.   |

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
  `src/i18n/en/` and the same key in `tr/` and `ar/` (the typecheck fails otherwise); `core.ts`
  only for shared words. Dates and numbers through `localeTag()` / `formatNumber`, never a fixed
  locale; never read the language once at module load (it changes at runtime). Never use a plural category name (`zero`,
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

- No recorded browser session with data; loading, empty, and error states, phone widths, and
  keyboard use have not been checked by a person. The Phase 7 panels and pages have never shown
  a real summary, and the AI keys card has never checked a real key.
- The light colours, the redesign, and the Turkish and Arabic pages are contrast and type tested
  and seen in headless screenshots, but not yet looked at by a person on every page; the theme
  and language choices are per browser, not per user (`User.locale` is separate and still sets
  the notification language). No native speaker has reviewed the Turkish and Arabic texts.
- `LanguageGate` renders nothing on the server, so every page is blank until the browser has run
  the script.
- `next build` downloads the Inter and IBM Plex Sans Arabic fonts (`next/font/google`), so it
  needs an internet connection.
- On the owner's PC the dev server lags (Turbopack watching `node_modules/.pnpm-task-run-state-v1`);
  use a production build there.
- The Summaries and AI usage entries are shown by role, also while the AI features are off (the
  pages then show no summaries or zero usage).
- The API status card (`src/components/api-status.tsx`, `hooks/use-api-health.ts`) is shown on
  the Settings page (admin) since Phase 6 (2026-10-28); the health texts themselves come from `@ops/shared`
  in English. The Phase 3 session card was removed (the user menu replaces it).
- A 403 from `POST /auth/login` means the page's origin is not in `CORS_ORIGINS`.
- No nonce-based CSP yet; in production the web app and the API must be same-site (or
  `AUTH_COOKIE_DOMAIN` set) and on HTTPS.
- The public OpenStreetMap tiles are for development and light use only; set
  `NEXT_PUBLIC_MAP_TILE_URL` before production.
- `NEXT_PUBLIC_*` values are inlined at build and dev-server start; restart after changing them.
- `typecheck` runs `next typegen` first; `agentRules: false` must stay in `next.config.ts`.
- The `description` in `package.json` still says "Operations App".
