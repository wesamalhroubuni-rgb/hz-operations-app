# ADR-0001: Tech stack

- **Status**: Accepted
- **Date**: 2026-10-12
- **Phase**: 1 (Setup & architecture)

## Context

The Operations App needs three deliverables that share one data contract:

- a phone app for workers on iOS and Android, from one codebase, that will later work offline;
- a web dashboard for supervisors, managers, and admins;
- a backend that owns the data, enforces role and scope permissions, keeps an audit trail, and
  later hosts an AI layer.

It is built by Kaneri.ai, which wants the platform parts (auth, permissions, notifications, audit
log, AI layer, configuration) to be reusable in other products. The team is small, development
happens on Windows 11, and much of the code is written with AI agents, so the stack should be
mainstream, strongly typed, and consistent across all three deliverables.

## Decision

One TypeScript monorepo.

| Concern         | Choice                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| Workspace       | pnpm 12 workspaces + Turborepo 2                                              |
| Language        | TypeScript, strict mode, everywhere                                           |
| Mobile app      | React Native with Expo SDK 57 (`apps/mobile`), run in Expo Go for now         |
| Web dashboard   | Next.js 16.4, App Router (`apps/web`)                                         |
| API             | NestJS 12, REST (`apps/api`)                                                  |
| Database        | PostgreSQL 17 through Docker Compose for development                          |
| Data access     | Prisma 7 with the `@prisma/adapter-pg` driver adapter                         |
| Shared contract | `packages/shared`: TypeScript types and Zod 4 schemas                         |
| Shared tooling  | `packages/config`: ESLint 10 flat config, Prettier 3, tsconfig presets        |
| Configuration   | Environment variables; one root `.env`; committed `.env.example`              |
| Runtime         | Node 24 LTS                                                                   |
| Tests           | Vitest 5 (shared, web); Jest 30 + ts-jest (api); Jest 29 + jest-expo (mobile) |

## Reasons

- **One language end to end.** A Zod schema in `@ops/shared` defines a request or response once.
  The API, the web app, and the mobile app all validate against the same definition, so the
  contract cannot drift silently.
- **Expo** gives iOS and Android from one codebase, and Expo Go lets a developer on Windows test on
  a real phone with no Mac and no native build during early phases.
- **Next.js** is a mainstream React framework, so the dashboard shares React knowledge and
  component patterns with the mobile app.
- **NestJS** imposes a module structure with dependency injection. That matches the requirement to
  keep platform components in self-contained modules that can be extracted later, and it has
  first-class guards and interceptors for permissions and audit logging.
- **PostgreSQL** is a dependable relational database with strong support for the constraints,
  transactions, and JSON columns that an audit log and a permission model need.
- **Prisma** gives typed queries and managed migrations from one schema file.
- **pnpm + Turborepo** install fast, keep packages isolated, and run tasks in dependency order with
  caching.
- **REST** is simple to secure, cache, log, and audit per endpoint, and simple for an offline
  outbox to replay.

## Version decisions

Checked against the manifests on 2026-10-12.

| Package             | Version in the repo                    | Why this version                                                                                                                                                |
| ------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                | 24 LTS (`engines: >=24.0.0`, `.nvmrc`) | Current LTS. It can `require` ESM-only packages, which the NestJS 12 decision below depends on.                                                                 |
| pnpm                | `12.11.2` (`packageManager`)           | Current major. Its supply-chain defaults are stricter; see Consequences.                                                                                        |
| Turborepo           | `^2.11.7`                              | Current major.                                                                                                                                                  |
| TypeScript          | `~6.0.3` in every package              | npm `latest` is 7.0, but typescript-eslint 8 supports `<6.1` and ts-jest supports `<7`. The Nest CLI and Expo templates are on 6.0. One version repo-wide.      |
| Prisma              | exactly `7.10.0`                       | The npm `latest` tag points to an 8.0 release candidate. `prisma`, `@prisma/client`, and `@prisma/adapter-pg` are pinned without a range so they move together. |
| React               | exactly `19.2.3` in web and mobile     | The version Expo SDK 57 pins. Using it in the web app too keeps a single React version in the workspace.                                                        |
| Expo / React Native | Expo `~57.0.28`, RN `0.86.3`           | Current SDK. The React Native version is the one that SDK requires.                                                                                             |
| Next.js             | `~16.4.0`                              | Current minor, held to patch updates.                                                                                                                           |
| NestJS              | `^12.1.3`                              | Current major. Its packages are ESM-only. The API stays CommonJS and Node 24 loads them through `require`.                                                      |
| ESLint              | `^10.12.0`, flat config                | Current major. Flat config is the only supported format.                                                                                                        |
| Zod                 | `^4.6.7`                               | Current major.                                                                                                                                                  |
| Vitest              | `^5.0.4` (shared, web)                 | Fast, no transform configuration needed for plain TypeScript.                                                                                                   |
| Jest (api)          | `^30.5.2` + ts-jest `^29.4.14`         | The NestJS testing utilities are built around Jest. The script runs Node with `--experimental-vm-modules` because the Nest packages are ESM.                    |
| Jest (mobile)       | `~29.7.0` + jest-expo `~57.0.6`        | jest-expo 57 depends on Jest 29 packages.                                                                                                                       |
| PostgreSQL          | `postgres:17-alpine`                   | Stable major, small image.                                                                                                                                      |

## Tradeoffs

- **Three test runners.** Each one is the natural fit for its framework, but developers must know
  which runner a folder uses. Each `memory.md` states it.
- **Two Jest majors** (30 in the API, 29 in mobile) live in one workspace. pnpm's isolated layout
  keeps them apart.
- **Several pins sit below npm `latest`** (TypeScript, Prisma). They need a deliberate upgrade
  later rather than arriving through a routine update.
- **The API is CommonJS while its framework is ESM-only.** This works on Node 24 but needs the
  experimental VM modules flag for Jest, and the API must not be switched to `"type": "module"`
  without revisiting the Prisma client output format (`moduleFormat = "cjs"`) and the Jest setup.
- **`@ops/shared` is consumed as compiled CommonJS**, not as source. It must be built before its
  dependants typecheck or build. Turbo's `^build` dependency handles this, at the cost of a build
  step before lint, typecheck, and test.
- **Expo Go limits native modules** to those in the Expo SDK. A development build will be needed if
  a later phase requires a native module outside it.
- **Prisma hides SQL.** Scope filtering must be applied deliberately in every query; Prisma does not
  enforce it.
- **Very new majors** across the stack mean fewer examples and occasional tooling gaps. Two are
  already worked around: eslint-plugin-react's version detection fails on ESLint 10 (the mobile
  ESLint config states the React version), and eslint-config-next registers a second copy of the
  `@typescript-eslint` plugin (the web ESLint config strips it).

## Alternatives considered

| Alternative                                 | Why not                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Flutter for mobile                          | A second language (Dart). No shared schemas or types with the web app and API.                             |
| Separate native iOS and Android apps        | Two codebases for a small team.                                                                            |
| React Native without Expo                   | Needs a Mac and native toolchains from the first day. Expo can be ejected from later if required.          |
| Next.js API routes as the only backend      | Couples the API to the dashboard. The mobile app, background jobs, and the AI layer need a standalone API. |
| Express or Fastify without a framework      | No enforced module boundaries, which the reusable-platform goal depends on.                                |
| GraphQL or tRPC                             | REST is simpler to permission, audit, and replay from an offline queue. tRPC ties clients to TypeScript.   |
| A backend-as-a-service (Firebase, Supabase) | Provider lock-in for auth, permissions, and data, which are exactly the parts Kaneri wants to own.         |
| Drizzle or TypeORM instead of Prisma        | Prisma has the most mature migration workflow and typed client of the three.                               |
| npm or Yarn workspaces, or Nx               | pnpm is stricter about undeclared dependencies. Turborepo is lighter than Nx for a repo this size.         |
| One `.env` per app                          | The same values (API URL, database URL) would be duplicated and drift.                                     |

## Consequences

- Every app wraps its scripts with `dotenv -e ../../.env --` (dotenv-cli) so that all of them, and
  Docker Compose, read the one root `.env`.
- pnpm 12 blocks dependency build scripts until each is decided under `allowBuilds` in
  `pnpm-workspace.yaml`, and it records very recently published packages under
  `minimumReleaseAgeExclude`. Both lists must be reviewed whenever a dependency is added or updated.
- Version upgrades for TypeScript, Prisma, React, Expo, and React Native are deliberate tasks.
  Expo, React Native, and React must be upgraded together, in both the mobile and web apps.
- A change to this stack needs a new ADR that supersedes this one.
