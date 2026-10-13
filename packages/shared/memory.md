# packages/shared memory

Package `@ops/shared`. Last updated: 2026-10-13.

## Purpose

Everything the API, the web app, and the mobile app must agree on, defined once: the Zod schemas
of every request and response, the typed API client, the validation that must behave the same on
the server and in a form, and the design tokens.

## Current state

Five areas plus the health schema, all re-exported from `src/index.ts`.

| Area              | Contents                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/health.ts`   | `healthResponseSchema` / `HealthResponse`.                                                                                                                                                                                  |
| `src/common/`     | `apiErrorSchema` and `API_ERROR_CODES`; `paginationQuerySchema`, `sortQuerySchema`, `paginatedSchema`, `Paginated`, `DEFAULT_PAGE_SIZE` (25), `MAX_PAGE_SIZE` (100); `idSchema`, `isoDateTimeSchema`, `queryBooleanSchema`. |
| `src/domain/`     | One file per resource (`organization`, `users`, `memberships`, `sites`, `teams`, `log-types`, `tasks`, `work-logs`, `attachments`, `scope`), plus `enums.ts`, `custom-fields.ts`, and `shared.ts` (small building blocks).  |
| `src/platform/`   | `audit.ts` and `outbox.ts`: schemas, list queries, and endpoint functions for the two platform read APIs. `AUDIT_REDACTED` (`"[redacted]"`).                                                                                |
| `src/theme/`      | `tokens.ts` (colours, spacing, radii, font sizes and weights, `CONTRAST_REQUIREMENTS`), `contrast.ts` (WCAG maths), `css.ts` (`themeCssVariables`, `themeCss`).                                                             |
| `src/api-client/` | `client.ts` (transport, `ApiResult`, `DEV_USER_HEADER`, `REQUEST_ID_HEADER`, `healthEndpoints`), `health-monitor.ts`, `health-status.ts`, `index.ts` (`createApiClient`).                                                   |

432 unit tests in 9 files. Build, lint, typecheck, and test verified on 2026-10-13.

## What each resource file contains

Taking `work-logs.ts` as the model:

- `workLogSchema` / `WorkLog`: the wire shape of the record.
- `createWorkLogSchema`, `updateWorkLogSchema`, `changeWorkLogStatusSchema`: request bodies, all
  `z.strictObject`. Update schemas are partial and refuse an empty body.
- `listWorkLogsQuerySchema`: pagination, `sort` restricted to `WORK_LOG_SORT_FIELDS`, and the
  filters.
- `workLogListSchema`: the paginated envelope.
- `workLogsEndpoints(transport)`: the typed client functions for the resource.

## Key files

| File                               | What it does                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                     | The public entry point. Re-exports every area.                                                                                       |
| `src/common/errors.ts`             | The error body of every non-2xx API response (except `/health`).                                                                     |
| `src/common/pagination.ts`         | `page` / `pageSize`, `sort=field:asc\|desc`, the `{ items, page, pageSize, total }` envelope.                                        |
| `src/domain/enums.ts`              | `ROLES`, `TASK_STATUSES`, `TASK_PRIORITIES`, `WORK_LOG_STATUSES`, `WORK_LOG_SOURCES`. Must match the Prisma enums exactly, in order. |
| `src/domain/custom-fields.ts`      | Custom field definitions and `validateCustomFieldValues`, the single implementation of the rules (ADR-0003).                         |
| `src/domain/scope.ts`              | `resolvedScopeSchema`: the shape the API's scope resolution produces. The rules themselves live in the API.                          |
| `src/api-client/client.ts`         | `createApiTransport`: the one place that performs HTTP. Validates every body and never throws.                                       |
| `src/api-client/index.ts`          | `createApiClient(options)`: the transport plus every resource's endpoint functions.                                                  |
| `src/api-client/health-monitor.ts` | `createHealthMonitor`: framework-free check with retries after 2, 4, 8, 16 seconds (`HEALTH_RETRY_DELAYS_MS`).                       |
| `src/api-client/health-status.ts`  | `describeHealth` and `CHECK_AGAIN_LABEL`: the wording of the status card in both apps.                                               |
| `src/theme/tokens.ts`              | `darkTheme` (the only theme), `colors`, `spacing`, `radii`, `fontSizes`, `fontWeights`, `CONTRAST_REQUIREMENTS`.                     |
| `tsconfig.json`                    | Extends `@ops/config/tsconfig/library.json`. Adds the `DOM` lib, only for the types of `fetch`, `AbortController`, and timers.       |
| `tsconfig.build.json`              | Same, excluding `*.test.ts`. Used by `build` and `dev`.                                                                              |
| `eslint.config.mjs`                | The shared base config, unchanged.                                                                                                   |

## The API client

```ts
const client = createApiClient({ baseUrl, getHeaders: () => ({ 'x-dev-user-id': userId }) });
const result = await client.workLogs.list({ siteId, sort: 'occurredAt:desc' });
if (result.ok) {
  result.data.items;
} else {
  result.failure.kind; // 'network' | 'timeout' | 'invalid-response' | 'http'
}
```

- A call resolves to `ApiResult<Data>`; it never throws.
- `failure.kind === 'http'` carries the API's standard error body in `failure.error`; branch on
  `failure.error.code`.
- The default timeout is 10 seconds (`DEFAULT_API_TIMEOUT_MS`).
- `GET /health` answers 503 with a normal body when the database is down, so `health.get()`
  treats 503 as success (`alsoAccept`).
- `getHeaders` is where the dev header goes today and a token will go in Phase 3. Neither app
  passes it yet.
- To add a resource: write its schemas and `xxxEndpoints(transport)` in `src/domain/` (or
  `src/platform/` for a reusable one), export it from that folder's `index.ts`, and add it to
  `createApiClient`.

## Design tokens

- The palette was sampled from the client's logo (`docs/brand/`): `background` `#000000`,
  `primary` / `brandGold` `#D4A454`, `brandRed` / `accent` `#D80611`, `accentText` / `danger`
  `#FF6B6E`, `textPrimary` `#F5F1E8`.
- `brandRed` fails WCAG AA as normal text on black. Use it only for decoration; use `accentText`
  for red text.
- `CONTRAST_REQUIREMENTS` lists the allowed foreground and background pairings and the ratio each
  must reach. `theme.test.ts` checks every one, so a colour change that breaks AA fails the tests.
  Combine colours only as listed there.
- The web app turns the tokens into CSS variables with `themeCssVariables`; the mobile app imports
  the constants.
- A light theme would be a second `Theme` object next to `darkTheme`. None exists.

## How it is built and consumed

- `build` runs `tsc -p tsconfig.build.json` and emits **CommonJS** JavaScript, declarations, and
  source maps into `dist/`. The package has no `"type": "module"`, so NodeNext compiles to CommonJS.
- `package.json` points `main`, `types`, and `exports` at `dist/`. Consumers import the compiled
  output, not the source.
- **It must be built before any dependant can typecheck, lint, test, or build**, and before any
  Expo command (`apps/mobile/app.config.ts` imports the tokens). Turbo does this through the
  `^build` dependency on every task; the root `db:seed`, `db:reset`, and `test:integration`
  scripts build it explicitly. If an app reports that `@ops/shared` cannot be found, run
  `pnpm --filter @ops/shared build`.
- `dev` runs the same compile in watch mode, so `pnpm dev` at the root keeps `dist/` current.

## Scripts

| Script      | Command                                                    |
| ----------- | ---------------------------------------------------------- |
| `build`     | `tsc -p tsconfig.build.json`                               |
| `dev`       | `tsc -p tsconfig.build.json --watch --preserveWatchOutput` |
| `lint`      | `eslint .`                                                 |
| `typecheck` | `tsc --noEmit`                                             |
| `test`      | `vitest run`                                               |

## Conventions

- Relative imports inside this package **must end in `.js`** (`./health.js`), as NodeNext requires.
- Export the Zod schema and the type inferred from it together. Name them `xxxSchema` and `Xxx`.
- **Request bodies are `z.strictObject`.** An unknown key must be an error, not silently dropped.
  `strict-bodies.test.ts` checks this for every body schema; add new ones to it.
- Response schemas are plain `z.object`, so an older client tolerates a new field.
- Date ranges are inclusive at the lower bound and exclusive at the upper bound. Name the pair
  `xxxFrom` / `xxxTo` (or `from` / `to`).
- Query booleans use `queryBooleanSchema`, never `z.coerce.boolean()` (which reads `"false"` as
  true).
- 64-bit integers travel as decimal strings (`outboxSequenceSchema`).
- Logic belongs here only when the API and a client must behave identically (validation, status
  wording) or when both clients need it (the API client, the health monitor). Business rules that
  only the server applies stay in the API.
- Keep the package free of runtime dependencies other than Zod. It runs in Node, browsers, and
  React Native: use only `fetch`, `AbortController`, and timers. No other DOM API, no Node API, no
  React.
- `src/common/`, `src/platform/`, `src/theme/`, and the transport are product-neutral.
  `src/domain/` and the resource list in `createApiClient` are the Operations domain. Keep that
  split so the neutral parts can move to a shared Kaneri package.
- Tests are `*.test.ts` next to the code, run with Vitest.
- Changing a schema changes the contract for the API and both clients at once. Run the root
  `pnpm typecheck`, `pnpm test`, and `pnpm test:integration` after any change.

## Known issues

- Consumers see changes only after a rebuild. Outside `pnpm dev`, rebuild by hand or through a root
  script.
- The package is CommonJS only. An ESM-only consumer would need a dual build.
- The `DOM` lib is enabled for the whole package, so TypeScript will not stop someone from using
  `document` or `window`. Only review prevents it.
- `src/domain/shared.ts` imports a type from `src/api-client/client.ts`, and the resource files
  import the transport types, so `domain/` and `api-client/` depend on each other.
- The custom-field key rules and the audit redaction rule (in the API) are independent: nothing
  here warns that a field key such as `token_no` will be redacted in audit and outbox events.
- Old log type definitions have no schema or endpoint; only the current `fields` is exposed.
