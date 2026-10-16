# packages/shared memory

Package `@ops/shared`. Last updated: 2026-10-16.

## Purpose

Everything the API, the web app, and the mobile app must agree on, defined once: the Zod schemas
of every request and response, the typed API client and the sign-in session manager, the validation
and wording that must behave the same on the server and in both apps, and the design tokens.

## Current state

Five areas plus the health schema, all re-exported from `src/index.ts`.

| Area              | Contents                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/health.ts`   | `healthResponseSchema` / `HealthResponse`.                                                                                                                                                                                                                                                   |
| `src/common/`     | `apiErrorSchema` and `API_ERROR_CODES` (now including `rate_limited`); pagination, sort, id, date, and query-boolean schemas.                                                                                                                                                                |
| `src/domain/`     | One file per resource (`organization`, `users`, `memberships`, `sites`, `teams`, `log-types`, `tasks`, `work-logs`, `attachments`, `scope`), plus `enums.ts` (with `roleRank`, `rolesHighestFirst`), `custom-fields.ts`, and `shared.ts`.                                                    |
| `src/platform/`   | `auth.ts` (the sign-in wire contract), `audit.ts`, `outbox.ts`. `AUDIT_REDACTED`.                                                                                                                                                                                                            |
| `src/theme/`      | `tokens.ts`, `contrast.ts`, `css.ts`.                                                                                                                                                                                                                                                        |
| `src/api-client/` | `client.ts` (transport with auth hooks and refresh-once, `ApiResult`, `CSRF_HEADER`, `REQUEST_ID_HEADER`), `create-api-client.ts` (`createApiClient`), `auth-session.ts` (`createAuthSessionManager`), `auth-text.ts`, `auth-forms.ts`, `health-monitor.ts`, `health-status.ts`, `index.ts`. |

546 unit tests in 11 files, confirmed on 2026-10-16. `DEV_USER_HEADER` was removed in Phase 3.

## Phase 3 contract changes

- **Users** (`domain/users.ts`): `email` is optional and `username` new; a user needs at least one
  of email, phone, username (`hasLoginIdentifier`). Responses are a discriminated union on
  `profile`: `userBasicSchema` (id, displayName, roles), `userContactSchema` (adds email, phone),
  `userFullSchema` (adds organization, username, memberships, `activated`, timestamps).
  `createdUserSchema` is the full user plus `activation` (an `IssuedCode`). `normalizePhone` must
  match the API's (`apps/api/src/platform/auth/identifiers.ts`).
- **Organization** (`domain/organization.ts`): discriminated on `view`: `summary` (id, name, slug,
  `workLogEditWindowHours`) or `full` (adds settings, timestamps). Settings validate
  `workLogEditWindowHours` (positive, at most one year; default 24 via `workLogEditWindowHoursOf`)
  and keep other keys.
- **Memberships**: `ORG_WIDE_ROLES` and `membershipScopeIssues`: a manager or admin membership must
  be `orgWide: true` with no sites or teams (the create schema refuses it).
- **Work logs**: `createWorkLogSchema` has no `authorId` and allows `status` `draft` or `submitted`
  only (`WORK_LOG_CREATE_STATUSES`).
- **Scope**: `resolvedScopeSchema` gained `colleagueIds`.
- **Auth** (`platform/auth.ts`): `loginRequestSchema` (`identifier`, `password`, `client: 'web' |
'mobile'`, optional `organizationSlug`, `deviceName`), `loginResponseSchema`,
  `refreshRequestSchema`, `refreshResponseSchema`, `meResponseSchema`, `authUserSchema`,
  `authTokensSchema`, `setPasswordRequestSchema`, `changePasswordRequestSchema`,
  `authSessionSchema`, `issuedCodeSchema`, `newPasswordSchema` (10 to 128 characters), the cookie
  names `AUTH_ACCESS_COOKIE` / `AUTH_REFRESH_COOKIE`, and `authEndpoints(transport)`.

## Key files

| File                                  | What it does                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | The public entry point. Re-exports every area.                                                                                                                      |
| `src/common/errors.ts`                | The error body of every non-2xx API response (except `/health`).                                                                                                    |
| `src/domain/enums.ts`                 | `ROLES` (with `roleRank`, `rolesHighestFirst`), `TASK_STATUSES`, `TASK_PRIORITIES`, `WORK_LOG_STATUSES`, `WORK_LOG_SOURCES`. Must match the Prisma enums, in order. |
| `src/domain/custom-fields.ts`         | Custom field definitions and `validateCustomFieldValues` (ADR-0003).                                                                                                |
| `src/platform/auth.ts`                | The sign-in wire contract (above).                                                                                                                                  |
| `src/api-client/client.ts`            | `createApiTransport`: the one place that performs HTTP. Bearer token, CSRF header on non-GET, `credentials`, refresh once on a 401.                                 |
| `src/api-client/create-api-client.ts` | `createApiClient(options)`: the transport plus every resource's endpoint functions, including `auth`.                                                               |
| `src/api-client/auth-session.ts`      | `createAuthSessionManager` (web and mobile modes), `TokenStorage`, `AuthState`, `signInFailureReason`, `setPasswordFailure`.                                        |
| `src/api-client/auth-text.ts`         | Every sign-in, activation, and sign-out sentence (`AUTH_TEXT`, `AUTH_FAILURE_MESSAGES`, `AUTH_NOTICE_MESSAGES`) and `roleLabel`.                                    |
| `src/api-client/auth-forms.ts`        | `validateSignInForm`, `validateSetPasswordForm`, `newPasswordProblem`, `isFormValid`.                                                                               |
| `src/api-client/health-monitor.ts`    | `createHealthMonitor` with retries after 2, 4, 8, 16 seconds.                                                                                                       |
| `src/theme/tokens.ts`                 | `darkTheme`, `colors`, `spacing`, `radii`, `fontSizes`, `fontWeights`, `CONTRAST_REQUIREMENTS`.                                                                     |
| `tsconfig.json`                       | Extends `@ops/config/tsconfig/library.json`. Adds the `DOM` lib, only for `fetch`, `AbortController`, and timers.                                                   |

## The API client and the session manager

```ts
const session = createAuthSessionManager({ baseUrl, mode: 'web', organizationSlug });
await session.start(); // GET /auth/me (web) or load tokens from storage first (mobile)
const result = await session.signIn(identifier, password); // { ok } or { ok: false, failure }
const logs = await session.client.workLogs.list({ sort: 'occurredAt:desc' });
```

- A call resolves to `ApiResult<Data>`; it never throws. Branch on `failure.error.code` for HTTP
  errors.
- **Transport**: on a 401 it calls `auth.refresh()` once (concurrent 401s share it) and repeats the
  request once; a second 401 or a failed refresh calls `auth.onAuthLost()`. No loops.
  `skipAuthRefresh` on a request opts out (the auth endpoints use it where needed).
- **`mode: 'web'`**: `credentials: 'include'`; the cookies are the session; the CSRF token from
  login, refresh, or `/auth/me` is kept in memory and sent as `x-csrf-token`.
- **`mode: 'mobile'`**: `credentials: 'omit'`; tokens in memory and in the given `TokenStorage`;
  the rotated pair is saved before it is used; logout names the session by refresh token.
- State: `loading`, `signedOut` (notice `session_expired`, `unreachable`, or
  `sign_out_unconfirmed`), `signedIn` (with `AuthUser`). `signOut()` always ends signed out;
  `signOutEverywhere()` stays signed in when the server could not confirm. A failed refresh that
  is not a 400 or 401 keeps the session.
- The manager never logs and never puts a password, code, or token in a message.
- To add a resource: write its schemas and `xxxEndpoints(transport)` in `src/domain/` (or
  `src/platform/`), export it, and add it to `createApiClient` in `create-api-client.ts`.

## Design tokens

- Palette from the client's logo: `background` `#000000`, `primary` / `brandGold` `#D4A454`,
  `brandRed` / `accent` `#D80611`, `accentText` / `danger` `#FF6B6E`, `textPrimary` `#F5F1E8`.
- `brandRed` fails WCAG AA as normal text on black; use it only for decoration.
- `CONTRAST_REQUIREMENTS` lists the allowed pairings; `theme.test.ts` checks every one.

## How it is built and consumed

- `build` runs `tsc -p tsconfig.build.json` and emits **CommonJS**, declarations, and source maps
  into `dist/`. `main`, `types`, and `exports` point at `dist/`.
- **It must be built before any dependant can typecheck, lint, test, or build**, and before any
  Expo command. Turbo does this through `^build`; the root `db:seed`, `db:reset`, and
  `test:integration` scripts build it explicitly.
- `dev` runs the same compile in watch mode.

## Scripts

| Script      | Command                                                    |
| ----------- | ---------------------------------------------------------- |
| `build`     | `tsc -p tsconfig.build.json`                               |
| `dev`       | `tsc -p tsconfig.build.json --watch --preserveWatchOutput` |
| `lint`      | `eslint .`                                                 |
| `typecheck` | `tsc --noEmit`                                             |
| `test`      | `vitest run`                                               |

## Conventions

- Relative imports inside this package **must end in `.js`**.
- Export the Zod schema and the type inferred from it together (`xxxSchema`, `Xxx`).
- **Request bodies are `z.strictObject`.** `strict-bodies.test.ts` checks every body schema; add
  new ones to it. Server-set fields (`authorId`, `createdById`, `uploadedById`) are never in a
  request schema.
- Response schemas are plain `z.object` (or discriminated unions of them), so an older client
  tolerates a new field.
- Date ranges are inclusive at the lower bound and exclusive at the upper bound.
- Query booleans use `queryBooleanSchema`, never `z.coerce.boolean()`.
- 64-bit integers travel as decimal strings.
- Logic belongs here only when the API and a client must behave identically (validation,
  identifier normalisation, wording) or when both clients need it (the API client, the session
  manager, the health monitor). Authorization rules stay in the API.
- No runtime dependency other than Zod. Only `fetch`, `AbortController`, and timers; no other DOM
  API, no Node API, no React, no React Native.
- `src/common/`, `src/platform/`, `src/theme/`, the transport, and the session manager are
  product-neutral; `src/domain/` and the resource list in `createApiClient` are the Operations
  domain.
- Tests are `*.test.ts` next to the code, run with Vitest.
- Changing a schema changes the contract for the API and both clients at once. Run the root
  `pnpm typecheck`, `pnpm test`, and `pnpm test:integration` after any change.

## Known issues

- Consumers see changes only after a rebuild.
- CommonJS only; an ESM-only consumer would need a dual build.
- The `DOM` lib is enabled for the whole package, so TypeScript will not stop someone from using
  `document` or `window`.
- `src/domain/` and `src/api-client/` import each other's types.
- The comment on `listUsersQuerySchema` says a search matches the username for contact-visible
  users; the API matches the username for admins only.
- The custom-field key rules and the audit redaction rule (in the API) are independent.
- Old log type definitions have no schema or endpoint.
