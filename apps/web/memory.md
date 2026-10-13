# apps/web memory

Package `@ops/web`. Last updated: 2026-10-12.

## Purpose

The manager dashboard: a web app where supervisors, managers, and admins monitor the work that
workers log. Built with Next.js (App Router) and React.

## Current state

Phase 1 placeholder. One page at `/` with a heading and an "API status" card.

- The card is a client component. In the browser it calls `GET {NEXT_PUBLIC_API_URL}/health`,
  validates the body with `healthResponseSchema` from `@ops/shared`, and shows one of: checking,
  reachable with database up, reachable with database down, unreachable. A "Check again" button
  repeats the call.
- Styling is plain CSS Modules with CSS variables and a light and dark colour scheme. No UI
  library.
- No sign-in, no routes beyond `/`, no data views.
- 6 unit tests, all in `src/lib/api/health.test.ts`.

Verified on 2026-10-12: the dev server answers 200 on port 3000 with the placeholder HTML. **Not
yet verified**: the status card in a real browser.

## Key files

| File                            | What it does                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/app/layout.tsx`            | Root layout, metadata, viewport, global CSS.                                                      |
| `src/app/page.tsx`              | The placeholder home page.                                                                        |
| `src/app/icon.svg`              | Favicon.                                                                                          |
| `src/components/api-status.tsx` | The status card (`'use client'`).                                                                 |
| `src/lib/env.ts`                | The only place that reads environment variables. Validates `NEXT_PUBLIC_API_URL` with Zod.        |
| `src/lib/api/health.ts`         | `fetchApiHealth(apiUrl, timeoutMs)`. Never throws; returns a typed result.                        |
| `scripts/next.mjs`              | Launcher that copies `WEB_PORT` to `PORT`, then runs the Next.js CLI.                             |
| `next.config.ts`                | Strict mode, `agentRules: false`, and the monorepo root for Turbopack and file tracing.           |
| `eslint.config.mjs`             | Base config plus `eslint-config-next`, with Next's duplicate `@typescript-eslint` plugin removed. |
| `vitest.config.mts`             | Node environment, `src/**/*.test.ts`, `@` alias to `src`.                                         |
| `tsconfig.json`                 | Extends the shared base. `@/*` maps to `./src/*`.                                                 |

`next-env.d.ts` and `.next/` are generated and git-ignored.

## Environment variables

| Variable              | Used by            | Notes                                                    |
| --------------------- | ------------------ | -------------------------------------------------------- |
| `WEB_PORT`            | `scripts/next.mjs` | Port for `dev` and `start`. Next.js itself reads `PORT`. |
| `NEXT_PUBLIC_API_URL` | `src/lib/env.ts`   | Must be an `http` or `https` URL. Inlined at build time. |

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

- `src/app/` is routing and layout. `src/components/` is UI. `src/lib/` is logic with no React in
  it, and that is where tests go.
- Read environment variables only in `src/lib/env.ts`, and write each one out in full
  (`process.env.NEXT_PUBLIC_API_URL`), because Next.js inlines them by exact text match.
- Functions that call the API return a typed result union and do not throw. Parse the response body
  with a schema from `@ops/shared` whatever the HTTP status is.
- Import from `src` with the `@/` alias.
- Components are server components unless they need state or browser APIs; then add `'use client'`.
- Tests are `*.test.ts` next to the code, run with Vitest in a Node environment, and stub `fetch`
  with `vi.stubGlobal`.
- React is pinned to exactly `19.2.3` to match the mobile app. Change both together.

## Known issues

- `src/lib/env.ts` never throws. If `NEXT_PUBLIC_API_URL` is missing or not an http(s) URL,
  `env.apiUrl` is `null` and the status card shows "API not configured". The build passes without a
  root `.env`, but the value is inlined at build time, so a real build must have it set.
- A request timeout is reported as reason `network`, the same as a refused connection.
- `CORS_ORIGINS` on the API must contain the exact origin the dashboard is opened from. Opening the
  dashboard by IP address instead of `http://localhost:3000` makes the status card show
  "API unreachable" until that origin is added.
- `typecheck` runs `next typegen` first because `tsconfig.json` includes generated route types.
- There are no component tests; only `src/lib` logic is tested. The Vitest environment is `node`,
  so component tests will need a DOM environment added.
- `agentRules: false` in `next.config.ts` must stay, or `next dev` generates its own `AGENTS.md`
  in this folder.
