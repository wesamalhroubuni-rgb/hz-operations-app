# AGENTS.md

Rules for AI agents working on the Operations App monorepo. `CLAUDE.md` imports this file, so it
is loaded into every session. Keep it short and true.

## Working directory

Always state and work in `D:\Personal Projects\Huseyin\Operations_App` (Windows 11, PowerShell).
Run every command from this root unless a step says otherwise.

## Read order at the start of every session

1. `AGENTS.md` (this file)
2. [MEMORY.md](MEMORY.md): current state, what works, what is unverified, session log
3. [ARCHITECTURE.md](ARCHITECTURE.md): structure, layering, what exists versus what is planned
4. [ROADMAP.md](ROADMAP.md): the 8 phases and their "done when" criteria
5. The `memory.md` of every folder you will touch (`apps/api`, `apps/web`, `apps/mobile`,
   `packages/shared`, `packages/config`)

Decisions are recorded in [docs/decisions/](docs/decisions/README.md). Human setup steps are in
[README.md](README.md).

## What this project is

Workers log their work from their phones (text, photos, location, later voice). Supervisors and
managers monitor it on a web dashboard. A later AI layer summarises, flags anomalies, and proposes
actions that a human approves. Built by Kaneri.ai. Roles: worker, supervisor, manager, admin. Users
see only the data their role and scope (team/site) allow, and the AI layer is bound by the same
rule.

## Engineering principles

- Make small, testable changes.
- Understand the existing code before modifying it.
- No unnecessary rewrites. Preserve working functionality.
- Keep business logic separate from UI, integrations, and presentation.
- No hard-coded credentials, environment values, or provider-specific logic where configuration or
  an abstraction fits. Configuration comes from environment variables documented in `.env.example`.
- Automated actions need clear error handling, logging, and traceability.
- Add or update tests when behaviour changes.
- Recommend one option. Do not list unranked alternatives.
- Reusable platform components (auth, permissions, notifications, audit log, AI layer,
  configuration) live in self-contained modules with no Operations-specific imports, so they can be
  extracted into shared Kaneri packages later. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Before a substantial feature, state

1. Business objective
2. Expected behaviour
3. Components affected
4. Data required
5. External integrations
6. Failure cases
7. Test plan

## After a substantial change, report

1. What changed
2. Why
3. Files modified
4. Architectural decisions (write an ADR in `docs/decisions/` for significant ones)
5. Tests performed
6. Limitations and next steps

## End of every session

Update [MEMORY.md](MEMORY.md) (state plus a dated session log entry, newest first) and the
`memory.md` of every folder touched. Use absolute dates (YYYY-MM-DD). Document what is in the repo,
not what was intended.

## Project subagents (`.claude/agents/`)

| Agent         | What it does                                                                                                                                                                                  | When to use it                                                                                           | Edits files?                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `reviewer`    | Independent review against `AGENTS.md`, the phase prompt, and the `ROADMAP.md` criteria. Runs install, lint, typecheck, test, build, and format check, starts the affected apps, and reports. | At the end of every phase and before reporting a substantial change as done.                             | No. Read-only; it reports findings and does not fix.   |
| `docs-keeper` | Brings `MEMORY.md`, `ARCHITECTURE.md`, `ROADMAP.md`, ADRs, `README.md`, and folder `memory.md` files in line with the code. The repo wins over the session summary.                           | At the end of every session and after any architectural decision.                                        | Docs only. Never source, config, or tests.             |
| `test-writer` | Writes and runs tests for new or changed behaviour, including failure cases and both the allowed and denied case for permission rules.                                                        | Whenever behaviour is added or changed, and when fixing a bug (write the test that reproduces it first). | Tests; production code only minimally for testability. |

## Commands

All from the repo root. Package names: `@ops/api`, `@ops/web`, `@ops/mobile`, `@ops/shared`,
`@ops/config`.

| Task                    | Command                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| Install                 | `pnpm install`                                                        |
| Start / stop PostgreSQL | `pnpm db:up` / `pnpm db:down` (logs: `pnpm db:logs`)                  |
| Run everything          | `pnpm dev`                                                            |
| Run one app             | `pnpm --filter @ops/api dev` (same for `@ops/web`, `@ops/mobile`)     |
| Checks                  | `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`              |
| Formatting              | `pnpm format` (writes), `pnpm format:check`                           |
| Prisma                  | `pnpm --filter @ops/api db:migrate` (also `db:generate`, `db:studio`) |

Ports: API 3001 (`/health`), web 3000, Metro 8081, PostgreSQL 5432.

If `node`, `pnpm`, or `git` are not found in an agent shell, prefix the command with:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;C:\Program Files\Git\cmd;$env:Path";
```

## Gotchas

**Environment**

- There is one `.env`, at the repo root, for every app and for Docker Compose. App scripts load it
  with `dotenv -e ../../.env --` (dotenv-cli). Do not add per-app `.env` files.
- A new variable must be added to `.env.example`, to the consuming app's validation
  (`apps/api/src/config/env.ts`, `apps/web/src/lib/env.ts`, `apps/mobile/src/config/env.ts`), and
  to `globalPassThroughEnv` in `turbo.json`. Turbo runs tasks in strict env mode and strips any
  shell or CI variable that is not listed there.
- PostgreSQL is published on `127.0.0.1` only. Do not widen the port mapping in
  `docker-compose.yml`; only the API (3001) and Metro (8081) need to be reachable from a phone.
- The API validates its environment with Zod at boot and exits with one line per bad variable.
  All six API variables are required, including `DATABASE_CONNECT_TIMEOUT_MS`.
- `NEXT_PUBLIC_*` and `EXPO_PUBLIC_*` values are inlined at bundle time. Restart the dev server
  after changing them; `expo export` needs `--clear`.

**Build order**

- `@ops/shared` compiles to CommonJS in `packages/shared/dist` and must be built before anything
  that depends on it can typecheck, lint, test, or build. Turbo's `^build` dependency does this, so
  use the root scripts. If you run a tool directly inside an app, build `@ops/shared` first.
- `prisma generate` runs on API `postinstall` and before API `dev`, `build`, `typecheck`, and
  `test`. The client is generated into `apps/api/src/generated/` (git-ignored). Never edit it.

**pnpm 12**

- Supply-chain policy: pnpm appends `minimumReleaseAgeExclude` entries to `pnpm-workspace.yaml` for
  very recently published packages. Review those entries whenever you add or update a dependency.
- Dependency build scripts are blocked until decided under `allowBuilds` in `pnpm-workspace.yaml`.
  `pnpm install` exits 1 while any is undecided. Current decisions: `prisma` and `@prisma/engines`
  allowed; `@parcel/watcher` and `unrs-resolver` denied (their prebuilt binaries work).
- `pnpm run` and `pnpm exec` perform an implicit install when a manifest has changed.
- From PowerShell, `pnpm exec dotenv ... -- <cmd>` loses the arguments after `--`. For ad-hoc
  commands call `node_modules\.bin\dotenv.cmd` directly. Package scripts are not affected.

**Version pins (do not bump casually; see [ADR-0001](docs/decisions/0001-tech-stack.md))**

| Pin                                         | Why                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| TypeScript `~6.0.3` everywhere              | npm `latest` is 7.0; typescript-eslint 8 supports `<6.1`; Nest CLI and Expo templates are on 6.0. |
| Prisma exactly `7.10.0` (three packages)    | The npm `latest` tag points to an 8.0 release candidate.                                          |
| React exactly `19.2.3` in web and mobile    | The version Expo SDK 57 pins. One React version across the repo.                                  |
| Expo SDK 57 / React Native `0.86.3`         | Must match each other and Expo Go. Upgrade them together.                                         |
| NestJS 12 with a CommonJS API               | Nest 12 packages are ESM-only; Node 24 loads them via `require`. Do not add `"type": "module"`.   |
| Jest 30 (api), Jest 29 + jest-expo (mobile) | The API test script needs `node --experimental-vm-modules`. jest-expo 57 is built for Jest 29.    |

**Per app**

- API: `/health` logs an error on every call while the database is down. Do not poll it tightly.
- Web: `scripts/next.mjs` maps `WEB_PORT` to `PORT`. `agentRules: false` in `next.config.ts` stops
  Next.js generating its own `AGENTS.md` in `apps/web`. `typecheck` runs `next typegen` first.
- Mobile: no `metro.config.js` or `babel.config.js` (Expo defaults handle the pnpm layout). ESLint
  sets `settings.react.version` to `'19.2'` by hand; bump it when React changes. No `build` script
  by design. A phone cannot reach `localhost`; `EXPO_PUBLIC_API_URL` must be the PC's LAN address.

**This file**

- The block below is written and re-added by the `turbo` CLI. Leave it byte-for-byte unchanged and
  keep it at the end of the file. Write project rules above it.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
