# MEMORY.md

Current state of the Operations App project. Update this file at the end of every session. Newest
session log entry goes first. Last updated: 2026-10-12.

## Current phase

**Phase 1 (Setup & architecture): code complete, pending manual checks.** Five checks need a
person at the machine (see "Not yet verified"). Phase 2 (Backend core) is next. Phases are defined
in [ROADMAP.md](ROADMAP.md).

## What exists

| Area              | State                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo          | pnpm 12 workspaces + Turborepo 2. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `format`, `format:check`, `db:up`, `db:down`, `db:logs`. |
| `packages/config` | Shared ESLint 10 flat config, Prettier config, and three tsconfig presets (`strict`, `base`, `library`).                                              |
| `packages/shared` | One Zod schema and type: `healthResponseSchema` / `HealthResponse`. Built to CommonJS in `dist/`.                                                     |
| `apps/api`        | NestJS 12 API with validated environment, a lazy Prisma 7 client, and `GET /health`. The Prisma schema has no models.                                 |
| `apps/web`        | Next.js 16.4 placeholder page with an "API status" card that calls `GET /health` from the browser.                                                    |
| `apps/mobile`     | Expo SDK 57 placeholder screen with an "API status" card and a Retry button.                                                                          |
| Database          | `docker-compose.yml` defines PostgreSQL 17 (`postgres:17-alpine`) with a named volume and a health check. Never started.                              |
| Docs              | `AGENTS.md`, this file, `ARCHITECTURE.md`, `ROADMAP.md`, `README.md`, ADR-0001, and a `memory.md` in each app and package.                            |
| Subagents         | `reviewer`, `docs-keeper`, `test-writer` in `.claude/agents/`.                                                                                        |

There is no authentication, no permission model, no business data model, no audit log, no offline
storage, and no AI layer yet. All of those are planned; see [ARCHITECTURE.md](ARCHITECTURE.md).

## Verified (2026-10-12)

- Root `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm format:check` all pass. `pnpm build` also passes without a `.env`.
- Root `pnpm dev` starts the API, web, and Metro together (checked by the reviewer).
- Tests: 2 in `@ops/shared`, 3 in `@ops/api`, 6 in `@ops/web`, 5 in `@ops/mobile`.
- API runs with the database down: `GET /health` returns 503 with
  `{ status: 'error', database: 'down', timestamp }` and the process stays up.
- Web dev server answers 200 on port 3000 with the placeholder HTML.
- Mobile: Metro dev server reports running on `/status`, `expo export` succeeds for Android and
  iOS, and `expo-doctor` passes 21/21.

## Not yet verified

These need the machine to be rebooted first (WSL 2 and Docker Desktop are installed but have never
run) and, for the last one, a phone.

1. The PostgreSQL container starts with `pnpm db:up`.
2. `GET /health` returns 200 with `database: 'up'`.
3. `pnpm --filter @ops/api db:migrate` runs against the database.
4. The web "API status" card renders correctly in a real browser (only the server-rendered HTML was
   checked).
5. The mobile app opens on a real phone in Expo Go and reaches the API over Wi-Fi.

## Machine and repository state

- Node 24.20.0 (winget `OpenJS.NodeJS.LTS`), pnpm 12.11.2 (`npm install -g pnpm`), Git 2.55.
- WSL 2 and Docker Desktop installed. **The machine has not been rebooted since**, so Docker and
  PostgreSQL have never run.
- Windows long paths enabled; `git config --global core.longpaths true` set.
- `git init` done on branch `main`. **Nothing is committed** and no git user identity is configured
  (`user.name` / `user.email`). Set the identity before the first commit.
- A local `.env` exists (git-ignored) with the same keys as `.env.example`.

## Known limitations

- `/health` logs an error on every call while the database is down. Noisy if something polls it.
- `EXPO_PUBLIC_API_URL` defaults to `http://localhost:3001`, which a phone cannot reach. It must be
  set to the PC's Wi-Fi address before testing on a device.
- Mobile has no icon or splash assets, and no `build` script (it runs in Expo Go only).
- `expo start --tunnel` is not available; it needs `@expo/ngrok`, which is not installed.
- The web and mobile health clients are two separate implementations with slightly different
  result types (mobile reports `timeout` separately; web folds it into `network`). Agree one
  contract in `@ops/shared` before adding a second endpoint client in Phase 2.
- `.env` is a global Turbo dependency, so editing any value invalidates every cached task.
- Root `pnpm dev` runs Expo under Turbo, where the QR code did not appear in a non-interactive run.
  Run `pnpm --filter @ops/mobile dev` in its own terminal to get the QR code.
- No CI pipeline.

## Open questions

- Which authentication mechanism for Phase 3 (in-house credentials and sessions, or an external
  identity provider)? Needs an ADR before Phase 3 starts.
- Is scope by team, by site, or both, and can a user belong to more than one? Affects the Phase 2
  data model.
- Where are photos stored (object storage provider), and what are the size and retention limits?
- Which push notification provider, and are notifications needed before Phase 6?
- Which AI provider and hosting constraints apply to Phase 7 (data residency, cost limits)?
- Which local database for offline mode in Phase 5?
- Is a single tenant enough, or must the data model be multi-tenant from Phase 2 so other Kaneri
  products and customers can share the platform components?

## Session log

### 2026-10-12: Phase 1 setup and documentation

- **What changed**: machine prepared (Node, pnpm, Git, WSL 2, Docker Desktop, long paths). Monorepo
  scaffolded: root tooling, `packages/config`, `packages/shared`, `apps/api`, `apps/web`,
  `apps/mobile`, Docker Compose for PostgreSQL, `.env.example`, and three project subagents. The
  documentation system was then written from the code: `AGENTS.md`, `MEMORY.md`, `ARCHITECTURE.md`,
  `ROADMAP.md`, `README.md`, `docs/decisions/` with ADR-0001, and five folder `memory.md` files.
- **Why**: Phase 1 of the roadmap. Establish a working, documented base before any feature work.
- **Verified**: see "Verified" above.
- **Review**: an independent reviewer pass returned "pass with fixes", no blockers. Fixed in the
  same session and re-verified with the root checks:
  - The web app no longer throws when `NEXT_PUBLIC_API_URL` is missing; `env.apiUrl` is `null` and
    the status card shows "API not configured" (same behaviour as mobile). `pnpm build` now passes
    without a `.env`.
  - `turbo.json` lists the app variables in `globalPassThroughEnv`, so variables set in the shell
    or CI reach the tasks, not only those from `.env`.
  - PostgreSQL is published on `127.0.0.1` only (it was on all interfaces).
  - `packages/config/tsconfig/strict.json` holds the strictness flags; `base.json` and the mobile
    tsconfig both extend it, so mobile no longer copies them.
  - API scripts run `prisma generate --no-hints` to hide the "update to Prisma 8" banner.
- **Left to do**: reboot the machine, then run the five manual checks under "Not yet verified".
  Configure a git identity and make the first commit.
