# apps/web memory

Package `@ops/web`. Last updated: 2026-10-16.

## Purpose

The manager dashboard: a web app where supervisors, managers, and admins monitor the work that
workers log. Built with Next.js (App Router) and React.

## Current state

Sign-in only, no dashboard features yet (Phase 3, code complete on 2026-10-16).

- **`/login`**: branded sign-in form (email, phone, or username plus password). Signed-in users are
  sent on to `?next=` (sanitised) or `/`.
- **`/activate`**: activation and password reset with a one-time code. A code arriving as `?code=`
  in a link pre-fills the form and is removed from the address bar; the page is sent with
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. After success the user signs in.
- **`/` (protected)**: logo, product name, a session card with the user's name, role label, and
  organization, "Sign out" and "Sign out everywhere", and the API status card.
- **Session**: `createAuthSessionManager({ mode: 'web' })` from `@ops/shared`. The API keeps the
  session in httpOnly cookies the page cannot read; requests go with `credentials: 'include'`, and
  only the CSRF token is kept, in memory. On load the manager calls `GET /auth/me`. A 401 triggers
  one refresh and one repeat. Nothing is stored in `localStorage` or `sessionStorage`.
- **Route guard** (`AuthProvider` + `src/lib/auth/routes.ts`): signed-out users go to `/login`,
  protected content never flashes (a loading state is shown while the session is checked). It is a
  convenience only; the API authorises every request.
- **Security headers** (`next.config.ts`): `X-Frame-Options: DENY`, CSP limited to
  `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, `nosniff`,
  referrer and permissions policies, HSTS in production, `poweredByHeader: false`. No
  `script-src` / `style-src` yet: Next.js needs per-request nonces for that.
- **Branding and tokens** as in Phase 2: name from `NEXT_PUBLIC_BRAND_NAME` via `src/lib/brand.ts`,
  colours and sizes from the CSS variables generated from `@ops/shared` tokens.
- Sends `NEXT_PUBLIC_ORGANIZATION_SLUG` with every sign-in.
- 46 unit tests in 3 files (`src/lib/brand.test.ts`, `src/lib/api/client.test.ts`,
  `src/lib/auth/routes.test.ts`).

Verified in the Phase 3 session: lint, typecheck, and tests pass; the clients agent ran 24/24
automated browser checks of these flows against the real API. **Not verified**: the owner signing in in a real browser; `pnpm build` in the
final pass; the status card's automatic recovery watched in a real browser.

## Key files

| File                                                                                                             | What it does                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/app/layout.tsx`                                                                                             | Root layout. Metadata from the brand module; theme tokens on `<html>`; wraps pages in `AuthProvider`. |
| `src/app/page.tsx`                                                                                               | The protected placeholder home page: logo, name, label, `SessionCard`, `ApiStatus`, footer.           |
| `src/app/login/page.tsx`                                                                                         | Sign-in page (`AuthShell` + `LoginForm`).                                                             |
| `src/app/activate/page.tsx`                                                                                      | Activation and reset page; reads `?code=` (at most 200 characters) and passes it to `ActivateForm`.   |
| `src/components/auth-provider.tsx`                                                                               | Subscribes to the session manager, starts the session check once, `RouteGuard`, `useAuth()`.          |
| `src/components/session-card.tsx`                                                                                | Name, role label, organization, sign-out buttons.                                                     |
| `src/components/login-form.tsx`, `activate-form.tsx`, `form-fields.tsx`, `auth-shell.tsx`, `session-loading.tsx` | Sign-in UI. Wording from `AUTH_TEXT` in `@ops/shared`.                                                |
| `src/hooks/use-login-form.ts`, `use-activate-form.ts`, `use-sign-out.ts`                                         | Form and sign-out state.                                                                              |
| `src/hooks/use-api-health.ts`                                                                                    | Connects the shared health monitor to React.                                                          |
| `src/lib/auth/routes.ts`                                                                                         | Public paths, `sanitizeRedirectPath` (no open redirect), `guardView`, `guardRedirect`.                |
| `src/lib/api/client.ts`                                                                                          | `authSession` (web-mode session manager) and `apiClient`, both `null` without an API URL. `no-store`. |
| `src/lib/env.ts`                                                                                                 | The only place that reads environment variables: `apiUrl`, `brandName`, `organizationSlug`.           |
| `src/lib/brand.ts`                                                                                               | `brand`: name, app label, logo, and the "Powered by Kaneri.ai" line.                                  |
| `scripts/next.mjs`                                                                                               | Launcher that copies `WEB_PORT` to `PORT`, then runs the Next.js CLI.                                 |
| `next.config.ts`                                                                                                 | Strict mode, `agentRules: false`, monorepo root, `poweredByHeader: false`, security headers.          |
| `vitest.config.mts`                                                                                              | Node environment, `src/**/*.test.ts`, `@` alias to `src`.                                             |

`next-env.d.ts` and `.next/` are generated and git-ignored.

## Environment variables

| Variable                        | Used by            | Notes                                                                                      |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `WEB_PORT`                      | `scripts/next.mjs` | Port for `dev` and `start`. Next.js itself reads `PORT`.                                   |
| `NEXT_PUBLIC_API_URL`           | `src/lib/env.ts`   | Must be an `http` or `https` URL. Inlined at build time.                                   |
| `NEXT_PUBLIC_BRAND_NAME`        | `src/lib/env.ts`   | Product name shown in the dashboard. Falls back to "Operations". Inlined at build time.    |
| `NEXT_PUBLIC_ORGANIZATION_SLUG` | `src/lib/env.ts`   | Sent with every sign-in (`hz-demo`). Required by the API once several organizations exist. |

The API side must match: `CORS_ORIGINS` must contain the exact origin the dashboard is opened
from, and `WEB_APP_URL` is where activation links point.

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

- `src/app/` is routing and layout. `src/components/` is UI. `src/hooks/` connects shared logic to
  React. `src/lib/` is logic with no React in it, and that is where tests go.
- **Every call to the API goes through `apiClient` / `authSession`.** Calls return an `ApiResult`
  and never throw. Sign-in logic, wording, and form validation live in `@ops/shared`, not here.
- **Never store a token in the browser** and never read the session cookies; the API sets and reads
  them.
- New protected pages need nothing extra (every path except `/login` and `/activate` is protected);
  a new public page must be added to `PUBLIC_PATHS` in `src/lib/auth/routes.ts`.
- **Never write a client name in a component.** Read `brand` from `src/lib/brand.ts`.
- **Never write a colour, spacing, radius, or font size in a stylesheet.** Use the CSS variables.
  The brand red (`--color-accent`) is for decoration, not text.
- Read environment variables only in `src/lib/env.ts`, written out in full
  (`process.env.NEXT_PUBLIC_API_URL`), because Next.js inlines them by exact text match.
- Import from `src` with the `@/` alias.
- Components are server components unless they need state or browser APIs; then `'use client'`.
- React is pinned to exactly `19.2.3` to match the mobile app. Change both together.

## Known issues

- A 403 from `POST /auth/login` means the page's origin is not in `CORS_ORIGINS`; the form then
  shows the generic "Something went wrong" message.
- No `script-src` / `style-src` CSP yet (needs nonces before production).
- In production the web app and the API must be same-site (or `AUTH_COOKIE_DOMAIN` set) and on
  HTTPS, or the cookies are not sent.
- `src/lib/env.ts` never throws. Without a valid `NEXT_PUBLIC_API_URL`, `apiClient` is `null`,
  sign-in shows a configuration message, and the status card shows "API not configured".
- `NEXT_PUBLIC_*` values are inlined at build and dev-server start; restart after changing them.
- `typecheck` runs `next typegen` first because `tsconfig.json` includes generated route types.
- There are no component tests; only `src/lib` logic is tested (Vitest in a `node` environment).
- `agentRules: false` in `next.config.ts` must stay, or `next dev` generates its own `AGENTS.md`.
- The `description` in `package.json` still says "Operations App".
