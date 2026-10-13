# apps/web memory

Package `@ops/web`. Last updated: 2026-10-13.

## Purpose

The manager dashboard: a web app where supervisors, managers, and admins monitor the work that
workers log. Built with Next.js (App Router) and React.

## Current state

A branded placeholder. One page at `/` with the client's logo, the product name, the label
"Manager dashboard", an "API status" card, and a small "Powered by Kaneri.ai" footer.

- **Branding comes from configuration.** The name is `NEXT_PUBLIC_BRAND_NAME` (fallback
  "Operations"). Everything brand-related is read from `src/lib/brand.ts`. The page title is
  `<name> · Manager dashboard`.
- **Colours and sizes come from the design tokens in `@ops/shared`.** The root layout sets them as
  CSS custom properties on `<html>`. The theme is dark only.
- **The status card uses the shared API client and health monitor.** It calls `GET /health`
  through `apiClient.health.get`, and while nothing answers it retries after 2, 4, 8, and 16
  seconds, then waits for "Check again". States and wording come from `describeHealth` in
  `@ops/shared` and are the same as in the mobile app.
- It calls no endpoint other than `/health` and does not send the dev header. There is no
  sign-in, no route beyond `/`, and no data view.
- 6 unit tests in 2 files (`src/lib/brand.test.ts`, `src/lib/api/client.test.ts`).

Verified on 2026-10-13: lint, typecheck, tests, and build pass; the production build has the title
"HZ · Manager dashboard". **Not verified**: the page and the card's automatic recovery in a real
browser.

## Key files

| File                            | What it does                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/app/layout.tsx`            | Root layout. Metadata from the brand module; theme tokens as CSS variables on `<html>`.            |
| `src/app/page.tsx`              | The placeholder home page: logo, name, label, status card, footer.                                 |
| `src/app/globals.css`           | Base styles. Uses only `var(--...)` from the tokens.                                               |
| `src/app/icon.png`              | Favicon. Next.js picks it up by file name.                                                         |
| `src/app/apple-icon.png`        | Apple touch icon, picked up the same way.                                                          |
| `public/brand/logo-512.png`     | The logo shown on the page.                                                                        |
| `src/components/api-status.tsx` | The status card (`'use client'`).                                                                  |
| `src/hooks/use-api-health.ts`   | Connects the shared health monitor to React with `useSyncExternalStore`.                           |
| `src/lib/env.ts`                | The only place that reads environment variables. `env.apiUrl` (or `null`) and `env.brandName`.     |
| `src/lib/brand.ts`              | `brand`: name, app label, logo, and the "Powered by Kaneri.ai" line.                               |
| `src/lib/api/client.ts`         | `apiClient`: the app's one typed API client (`null` without an API URL). Uses `cache: 'no-store'`. |
| `scripts/next.mjs`              | Launcher that copies `WEB_PORT` to `PORT`, then runs the Next.js CLI.                              |
| `next.config.ts`                | Strict mode, `agentRules: false`, and the monorepo root for Turbopack and file tracing.            |
| `eslint.config.mjs`             | Base config plus `eslint-config-next`, with Next's duplicate `@typescript-eslint` plugin removed.  |
| `vitest.config.mts`             | Node environment, `src/**/*.test.ts`, `@` alias to `src`.                                          |
| `tsconfig.json`                 | Extends the shared base. `@/*` maps to `./src/*`.                                                  |

`next-env.d.ts` and `.next/` are generated and git-ignored. `src/app/icon.svg` and
`src/lib/api/health.ts` from Phase 1 were deleted.

## Environment variables

| Variable                 | Used by            | Notes                                                                                   |
| ------------------------ | ------------------ | --------------------------------------------------------------------------------------- |
| `WEB_PORT`               | `scripts/next.mjs` | Port for `dev` and `start`. Next.js itself reads `PORT`.                                |
| `NEXT_PUBLIC_API_URL`    | `src/lib/env.ts`   | Must be an `http` or `https` URL. Inlined at build time.                                |
| `NEXT_PUBLIC_BRAND_NAME` | `src/lib/env.ts`   | Product name shown in the dashboard. Falls back to "Operations". Inlined at build time. |

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

## Re-branding for another client

1. Set `NEXT_PUBLIC_BRAND_NAME`.
2. Replace `public/brand/logo-512.png`, `src/app/icon.png`, and `src/app/apple-icon.png` (same
   names, same sizes).
3. If the colours change, edit the tokens in `packages/shared/src/theme/tokens.ts`.
4. Restart the dev server.

## Conventions

- `src/app/` is routing and layout. `src/components/` is UI. `src/hooks/` connects shared logic to
  React. `src/lib/` is logic with no React in it, and that is where tests go.
- **Never write a client name in a component.** Read `brand` from `src/lib/brand.ts`. The only
  mention of Kaneri.ai is `brand.poweredBy`.
- **Never write a colour, spacing, radius, or font size in a stylesheet.** Use the CSS variables:
  `var(--color-...)`, `var(--space-...)`, `var(--radius-...)`, `var(--font-size-...)`,
  `var(--font-weight-...)`. Combine colours only as listed in `CONTRAST_REQUIREMENTS`; the brand
  red (`--color-accent`) is for decoration, not text.
- **Every call to the API goes through `apiClient`.** Calls return an `ApiResult` and never throw.
  Logic shared with mobile belongs in `@ops/shared`, not here.
- Read environment variables only in `src/lib/env.ts`, and write each one out in full
  (`process.env.NEXT_PUBLIC_API_URL`), because Next.js inlines them by exact text match.
- Import from `src` with the `@/` alias.
- Components are server components unless they need state or browser APIs; then add `'use client'`.
- Tests are `*.test.ts` next to the code, run with Vitest in a Node environment.
- React is pinned to exactly `19.2.3` to match the mobile app. Change both together.

## Known issues

- `src/lib/env.ts` never throws. If `NEXT_PUBLIC_API_URL` is missing or not an http(s) URL,
  `env.apiUrl` is `null` and the status card shows "API not configured". The build passes without a
  root `.env`, but the values are inlined at build time, so a real build must have them set.
- The brand name is read when the dev server starts. Restart `pnpm dev` after changing it.
- When the API needs the dev header or a token, pass `getHeaders` to `createApiClient` in
  `src/lib/api/client.ts`. Nothing sets it today, so any call other than `/health` would get 401.
- `CORS_ORIGINS` on the API must contain the exact origin the dashboard is opened from. Opening the
  dashboard by IP address instead of `http://localhost:3000` makes the status card show
  "API unreachable" until that origin is added.
- `typecheck` runs `next typegen` first because `tsconfig.json` includes generated route types.
- There are no component tests; only `src/lib` logic is tested. The Vitest environment is `node`,
  so component tests will need a DOM environment added.
- `agentRules: false` in `next.config.ts` must stay, or `next dev` generates its own `AGENTS.md`
  in this folder.
- The `description` in `package.json` still says "Operations App".
