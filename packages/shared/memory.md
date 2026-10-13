# packages/shared memory

Package `@ops/shared`. Last updated: 2026-10-12.

## Purpose

Types and Zod validation schemas shared by the API, the web app, and the mobile app. A shape that
crosses the network is defined here once, so the server and both clients validate against the same
definition.

## Current state

One schema and its inferred type:

- `healthResponseSchema`: `{ status: 'ok' | 'error', database: 'up' | 'down', timestamp }`, where
  `timestamp` is an ISO 8601 datetime string.
- `HealthResponse`: the type inferred from it.

2 unit tests in `src/health.test.ts`. Build, lint, typecheck, and test verified on 2026-10-12.

## Key files

| File                  | What it does                                                       |
| --------------------- | ------------------------------------------------------------------ |
| `src/index.ts`        | The public entry point. Re-exports every module.                   |
| `src/health.ts`       | `healthResponseSchema` and `HealthResponse`.                       |
| `tsconfig.json`       | Extends `@ops/config/tsconfig/library.json`. `src` in, `dist` out. |
| `tsconfig.build.json` | Same, excluding `*.test.ts`. Used by `build` and `dev`.            |
| `eslint.config.mjs`   | The shared base config, unchanged.                                 |

## How it is built and consumed

- `build` runs `tsc -p tsconfig.build.json` and emits **CommonJS** JavaScript, declarations, and
  source maps into `dist/`. The package has no `"type": "module"`, so NodeNext compiles to CommonJS.
- `package.json` points `main`, `types`, and `exports` at `dist/`. Consumers import the compiled
  output, not the source.
- **It must be built before any dependant can typecheck, lint, test, or build.** Turbo does this
  through the `^build` dependency on every task. If an app reports that `@ops/shared` cannot be
  found, run `pnpm --filter @ops/shared build`.
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

- One file per domain area in `src/`, re-exported from `src/index.ts`.
- Relative imports inside this package **must end in `.js`** (`./health.js`), as NodeNext requires.
- Export the Zod schema and the type inferred from it together. Name them `xxxSchema` and `Xxx`.
- Keep the package free of runtime dependencies other than Zod, and free of Node, browser, or React
  Native APIs. It runs in all three environments.
- No business logic and no I/O here. Schemas, types, and constants only.
- Tests are `*.test.ts` next to the code, run with Vitest.
- Changing a schema changes the contract for the API and both clients at once. Run the root
  `pnpm typecheck` and `pnpm test` after any change.

## Known issues

- Consumers see changes only after a rebuild. Outside `pnpm dev`, rebuild by hand or through a root
  script.
- The package is CommonJS only. An ESM-only consumer would need a dual build.
