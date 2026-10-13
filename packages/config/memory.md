# packages/config memory

Package `@ops/config`. Last updated: 2026-10-13 (the package itself did not change in Phase 2; only
the "Who uses what" table below was corrected).

## Purpose

One place for the ESLint, Prettier, and TypeScript settings that every app and package uses, so
code style and strictness are the same across the monorepo.

## Current state

Complete since Phase 1. The package holds configuration files only: no source code, no scripts, no
build step, no tests.

## Key files

| File                    | What it provides                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `eslint/base.mjs`       | ESLint 10 flat config: `@eslint/js` recommended, `typescript-eslint` recommended, Node globals, `eslint-config-prettier` last.      |
| `prettier.config.mjs`   | Single quotes, semicolons, trailing commas, print width 100, LF line endings.                                                       |
| `tsconfig/strict.json`  | Strictness flags only: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`. |
| `tsconfig/base.json`    | Extends `strict.json` and adds the ES2022 target and lib, `esModuleInterop`, `resolveJsonModule`, `skipLibCheck`.                   |
| `tsconfig/library.json` | Extends the base with NodeNext modules, declarations, and source maps. For packages that compile with `tsc`.                        |

Rules the ESLint base adds on top of the recommended sets:

- `@typescript-eslint/no-unused-vars` is an error; names starting with `_` are ignored.
- `@typescript-eslint/consistent-type-imports` is an error.

It ignores `node_modules`, `dist`, `.next`, `.expo`, `.turbo`, `coverage`, and `generated`.

## Who uses what

| Consumer          | ESLint                                                                                              | TypeScript                                       |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/shared` | The base, unchanged                                                                                 | `tsconfig/library.json`, plus the `DOM` lib      |
| `apps/api`        | The base, decorator parser options, and a rule forbidding `src/platform` to import `src/operations` | `tsconfig/base.json`                             |
| `apps/web`        | The base plus `eslint-config-next`                                                                  | `tsconfig/base.json`                             |
| `apps/mobile`     | `eslint-config-expo` then the base                                                                  | `expo/tsconfig.base` plus `tsconfig/strict.json` |
| Repo root         | none                                                                                                | none                                             |

Prettier is wired once, in the root `package.json`: `"prettier": "@ops/config/prettier.config.mjs"`.
The root scripts `pnpm format` and `pnpm format:check` run it over the whole repo, with exclusions
in the root `.prettierignore`.

## Conventions

- Consumers import by path: `@ops/config/eslint/base.mjs`, `@ops/config/tsconfig/base.json`,
  `@ops/config/tsconfig/library.json`.
- Every consumer lists `@ops/config` as a `workspace:*` dev dependency.
- Put a rule here when it applies to every package. Framework-specific rules stay in the app's own
  `eslint.config.mjs`, added after the base.
- `eslint` and `typescript` are peer dependencies. Each consumer installs its own, at the same
  versions (`eslint ^10.12.0`, `typescript ~6.0.3`).
- A change here affects every package. Run the root `pnpm lint`, `pnpm typecheck`, and
  `pnpm format:check` afterwards.

## Known issues

- TypeScript is held at `~6.0.3` because typescript-eslint 8 (`^8.71.2` here) supports TypeScript
  below 6.1. Moving to TypeScript 7 needs a typescript-eslint release that supports it.
- The base registers the `@typescript-eslint` plugin. A framework config that registers it again
  under the same name makes ESLint fail; `apps/web/eslint.config.mjs` strips the duplicate from
  `eslint-config-next`.
- The base sets Node globals only. Browser and React Native globals come from the framework configs
  in the web and mobile apps.
- The mobile app extends Expo's base plus `tsconfig/strict.json`, not `tsconfig/base.json`. Add new
  strictness flags to `strict.json` so every project gets them.
- Files at the repo root are formatted by Prettier but not linted.
