# Operations App

Workers log their work from their phones. Supervisors and managers monitor it on a web dashboard.
A later AI layer will summarise the work, flag anomalies, and propose actions for a human to
approve. Built by Kaneri.ai.

**Status (2026-10-12)**: Phase 1, project setup. The three apps run and show a placeholder screen
with an "API status" card. There are no features yet. See [ROADMAP.md](ROADMAP.md).

This guide is for a developer on Windows 11 using PowerShell.

## What is in the repository

| Path              | What it is                                          |
| ----------------- | --------------------------------------------------- |
| `apps/api`        | REST API (NestJS, Prisma, PostgreSQL)               |
| `apps/web`        | Manager dashboard (Next.js)                         |
| `apps/mobile`     | Worker app for iOS and Android (React Native, Expo) |
| `packages/shared` | Types and validation schemas used by all three apps |
| `packages/config` | Shared ESLint, Prettier, and TypeScript settings    |

More documentation:

- [ARCHITECTURE.md](ARCHITECTURE.md): how the system is structured
- [ROADMAP.md](ROADMAP.md): the phases and what "done" means for each
- [MEMORY.md](MEMORY.md): current state and session log
- [docs/decisions/](docs/decisions/README.md): why the main decisions were made
- [AGENTS.md](AGENTS.md): rules for AI agents working in this repository

## 1. Prerequisites

| Tool           | Version                    | Used for                        |
| -------------- | -------------------------- | ------------------------------- |
| Node.js        | 24 LTS                     | Everything                      |
| pnpm           | 12 (the repo pins 12.11.2) | Installing and running packages |
| Git            | Any recent version         | Source control                  |
| Docker Desktop | With the WSL 2 backend     | Running PostgreSQL              |
| Expo Go        | Latest, on your phone      | Running the mobile app          |

### Install the tools

Open PowerShell **as Administrator** and run:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
wsl --install
winget install Docker.DockerDesktop
```

**Restart the computer.** WSL 2 and Docker Desktop do not work until you do. After the restart,
start Docker Desktop once and wait until it reports that the engine is running.

Then open a new, normal PowerShell window and install pnpm:

```powershell
npm install -g pnpm
```

Install **Expo Go** on your phone from the App Store or Google Play.

### Enable long paths

`node_modules` paths can exceed the old Windows limit of 260 characters. In PowerShell as
Administrator:

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
git config --global core.longpaths true
```

### Check the versions

```powershell
node -v      # v24.x
pnpm -v      # 12.x
git --version
docker --version
```

If a command is not found, close the terminal and open a new one so it picks up the updated `PATH`.

## 2. First-time setup

Run these from the repository root.

```powershell
copy .env.example .env
pnpm install
pnpm db:up
```

1. **`copy .env.example .env`** creates your local configuration. `.env` is git-ignored. The
   default values work for local development on one PC. Every app, and Docker Compose, reads this
   one file.
2. **`pnpm install`** installs all packages and generates the Prisma client.
3. **`pnpm db:up`** starts PostgreSQL in Docker and waits until it is healthy. Docker Desktop must
   be running.

To check that everything is in order:

```powershell
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

## 3. Run the apps

### Everything at once

```powershell
pnpm dev
```

This starts the API, the web dashboard, the Expo dev server, and a watcher that rebuilds
`packages/shared`. Press `Ctrl+C` to stop.

### One app at a time

Use a separate terminal for each.

```powershell
pnpm --filter @ops/api dev
pnpm --filter @ops/web dev
pnpm --filter @ops/mobile dev
```

Running the mobile app in its own terminal is the easier way to see the QR code and use Expo's
keyboard shortcuts.

### URLs and ports

| What             | URL                             | Variable in `.env` |
| ---------------- | ------------------------------- | ------------------ |
| API health check | <http://localhost:3001/health>  | `API_PORT`         |
| Web dashboard    | <http://localhost:3000>         | `WEB_PORT`         |
| Expo dev server  | port 8081                       | (Expo default)     |
| PostgreSQL       | `localhost:5432` (this PC only) | `POSTGRES_PORT`    |

What to expect:

- `/health` returns `{"status":"ok","database":"up",...}` with HTTP 200 when PostgreSQL is running.
  If the database is stopped, the API keeps running and `/health` returns HTTP 503 with
  `"database":"down"`.
- The web dashboard shows a placeholder page with an "API status" card.

## 4. Open the mobile app on your phone (Expo Go)

A phone cannot reach `localhost` on your PC, so the app needs your PC's address on the Wi-Fi
network.

1. Connect the phone and the PC to the **same Wi-Fi network**.
2. Find the PC's Wi-Fi address. Run `ipconfig` and read the "IPv4 Address" of the Wi-Fi adapter.
3. Open `.env` and set `EXPO_PUBLIC_API_URL` to that address with port 3001:

   ```dotenv
   EXPO_PUBLIC_API_URL=http://<your-pc-wifi-ip>:3001
   ```

4. Allow Node.js through Windows Firewall on ports **8081** (Expo) and **3001** (API). Windows
   normally asks the first time Node listens; choose "Allow" for private networks. To add the rules
   by hand, in PowerShell as Administrator:

   ```powershell
   New-NetFirewallRule -DisplayName "Operations App dev (Expo 8081)" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow -Profile Private
   New-NetFirewallRule -DisplayName "Operations App dev (API 3001)" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow -Profile Private
   ```

5. Start the API and the mobile dev server, each in its own terminal:

   ```powershell
   pnpm --filter @ops/api dev
   pnpm --filter @ops/mobile dev
   ```

6. Scan the QR code shown in the terminal. On Android, scan it from inside Expo Go. On iPhone, scan
   it with the Camera app.

The app shows "API reachable" and "Database: up" when everything is connected.

If you change `EXPO_PUBLIC_API_URL`, stop the mobile dev server and start it again. The value is
built into the app bundle.

## 5. Root scripts

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `pnpm dev`          | Runs every app in development mode                                   |
| `pnpm build`        | Builds `packages/shared`, the API, and the web app                   |
| `pnpm lint`         | Runs ESLint in every package                                         |
| `pnpm typecheck`    | Runs the TypeScript compiler in every package without emitting files |
| `pnpm test`         | Runs every test suite                                                |
| `pnpm format`       | Formats the whole repository with Prettier                           |
| `pnpm format:check` | Checks formatting without changing files                             |
| `pnpm db:up`        | Starts PostgreSQL in Docker and waits until it is healthy            |
| `pnpm db:down`      | Stops PostgreSQL. The data is kept in a Docker volume                |
| `pnpm db:logs`      | Follows the PostgreSQL logs                                          |

Database commands for the API:

| Command                              | What it does                                          |
| ------------------------------------ | ----------------------------------------------------- |
| `pnpm --filter @ops/api db:migrate`  | Creates and applies migrations (`prisma migrate dev`) |
| `pnpm --filter @ops/api db:generate` | Regenerates the Prisma client                         |
| `pnpm --filter @ops/api db:studio`   | Opens Prisma Studio to browse the database            |

To run a script in one package only, add `--filter`, for example `pnpm --filter @ops/web test`.

## 6. Tests

```powershell
pnpm test
```

| Package           | Test runner           | Test files            |
| ----------------- | --------------------- | --------------------- |
| `packages/shared` | Vitest                | `src/**/*.test.ts`    |
| `apps/api`        | Jest                  | `src/**/*.spec.ts`    |
| `apps/web`        | Vitest                | `src/**/*.test.ts`    |
| `apps/mobile`     | Jest with `jest-expo` | `src/**/*.test.ts(x)` |

The tests need no database and no network.

## 7. Configuration

All configuration is in the root `.env`. [.env.example](.env.example) lists every variable with a
comment.

| Variable                                                             | Used by        | Purpose                                             |
| -------------------------------------------------------------------- | -------------- | --------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Docker Compose | The local PostgreSQL container                      |
| `DATABASE_URL`                                                       | API            | Connection string. Must match the values above      |
| `DATABASE_CONNECT_TIMEOUT_MS`                                        | API            | How long to wait for a database connection          |
| `API_HOST`, `API_PORT`                                               | API            | Where the API listens                               |
| `CORS_ORIGINS`                                                       | API            | Browser origins allowed to call the API             |
| `LOG_LEVEL`                                                          | API            | `verbose`, `debug`, `log`, `warn`, `error`, `fatal` |
| `WEB_PORT`                                                           | Web            | Port of the dashboard                               |
| `NEXT_PUBLIC_API_URL`                                                | Web            | API address used by the browser                     |
| `EXPO_PUBLIC_API_URL`                                                | Mobile         | API address used by the phone                       |

The password in `.env.example` is for local development only. Never commit `.env` or real secrets.

## 8. Troubleshooting

| Problem                                                        | What to do                                                                                                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`, `pnpm`, or `git` is not recognised                     | Close the terminal and open a new one. If it still fails, reinstall the tool.                                                                                                                |
| `pnpm db:up` fails with a Docker connection error              | Start Docker Desktop and wait for the engine. If Docker was just installed, restart the computer first.                                                                                      |
| `pnpm db:up` says a variable must be set                       | `.env` is missing or incomplete. Run `copy .env.example .env`.                                                                                                                               |
| `pnpm db:up` fails because port 5432 is in use                 | Another PostgreSQL is running. Stop it, or change `POSTGRES_PORT` and the port inside `DATABASE_URL`.                                                                                        |
| The API exits with "Invalid environment configuration"         | The message names each variable that is missing or wrong. Fix them in `.env`.                                                                                                                |
| `/health` returns 503 with `"database":"down"`                 | PostgreSQL is not running or `DATABASE_URL` does not match the `POSTGRES_*` values. Run `pnpm db:up`.                                                                                        |
| The web card shows "API unreachable"                           | Start the API. Check that `NEXT_PUBLIC_API_URL` is right and that `CORS_ORIGINS` contains the exact address you opened the dashboard from. Restart the web server after changing `.env`.     |
| The phone shows "API unreachable"                              | Check that `EXPO_PUBLIC_API_URL` is the PC's Wi-Fi address, that both devices are on the same network, and that the firewall allows ports 8081 and 3001. Then restart the mobile dev server. |
| Expo Go cannot load the project                                | Same network and firewall checks as above. Some guest and office networks block devices from seeing each other; use another network.                                                         |
| The phone still uses an old API address                        | Stop the mobile dev server and run `pnpm --filter @ops/mobile dev --clear`.                                                                                                                  |
| Port 3000, 3001, or 8081 is already in use                     | Stop the other program, or change `WEB_PORT` or `API_PORT` in `.env`. If you change `API_PORT`, also change both `*_API_URL` values.                                                         |
| `pnpm install` exits with an error about ignored build scripts | A new dependency wants to run an install script. Decide it under `allowBuilds` in `pnpm-workspace.yaml` (`true` to allow, `false` to deny), then run `pnpm install` again.                   |
| An app cannot find `@ops/shared`                               | Run `pnpm --filter @ops/shared build`. The root scripts do this automatically.                                                                                                               |
| Errors about `src/generated/prisma` in the API                 | Run `pnpm --filter @ops/api db:generate`.                                                                                                                                                    |
| "Filename too long" or path errors during install              | Enable long paths (section 1), then delete `node_modules` and run `pnpm install` again.                                                                                                      |
| To start again with an empty database                          | `docker compose down -v` deletes the database volume. Then run `pnpm db:up`.                                                                                                                 |
