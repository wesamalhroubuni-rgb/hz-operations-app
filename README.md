# HZ

Workers log their work from their phones. Supervisors and managers monitor it on a web dashboard.
A later AI layer will summarise the work, flag anomalies, and propose actions for a human to
approve.

**HZ** is the client's product. It is built and powered by Kaneri.ai. The repository folder
(`Operations_App`), the package names (`@ops/*`), and the database (`operations_app`) keep the
technical name "Operations". The name shown in the apps comes from configuration, so the same code
can be deployed for another client.

**Status (2026-10-13)**: Phase 2, backend core. The API has the data model, 38 endpoints, an audit
log, and an event outbox. The web and mobile apps are branded placeholders with an "API status"
card; they have no features yet. **There is no sign-in.** In development the API accepts the acting
user from a temporary header (section 4). See [ROADMAP.md](ROADMAP.md).

This guide is for a developer on Windows 11 using PowerShell.

## What is in the repository

| Path              | What it is                                                               |
| ----------------- | ------------------------------------------------------------------------ |
| `apps/api`        | REST API (NestJS, Prisma, PostgreSQL)                                    |
| `apps/web`        | Manager dashboard (Next.js)                                              |
| `apps/mobile`     | Worker app for iOS and Android (React Native, Expo)                      |
| `packages/shared` | Validation schemas, the typed API client, and design tokens for all apps |
| `packages/config` | Shared ESLint, Prettier, and TypeScript settings                         |
| `docs/decisions`  | Architecture Decision Records                                            |
| `docs/brand`      | The client's logo files                                                  |

More documentation:

- [ARCHITECTURE.md](ARCHITECTURE.md): how the system is structured, the data model, the API rules
- [ROADMAP.md](ROADMAP.md): the phases and what "done" means for each
- [MEMORY.md](MEMORY.md): current state, known limitations, and session log
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
pnpm db:migrate
pnpm db:seed
```

1. **`copy .env.example .env`** creates your local configuration. `.env` is git-ignored. The
   default values work for local development on one PC. Every app, and Docker Compose, reads this
   one file.
2. **`pnpm install`** installs all packages and generates the Prisma client.
3. **`pnpm db:up`** starts PostgreSQL in Docker and waits until it is healthy. Docker Desktop must
   be running.
4. **`pnpm db:migrate`** creates the tables.
5. **`pnpm db:seed`** adds demo data: one organization ("HZ Demo"), 2 sites, 3 teams, 10 users in
   every role, 3 log types, 8 tasks, and 25 work logs over the past 14 days. It prints each user's
   id; keep that output, you need an id to call the API. Running it again changes nothing.

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

**Restart `pnpm dev` after changing `.env`.** A running process keeps the values it started with,
including the brand name and the API settings.

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

| What               | URL                               | Variable in `.env` |
| ------------------ | --------------------------------- | ------------------ |
| API health check   | <http://localhost:3001/health>    | `API_PORT`         |
| API docs (Swagger) | <http://localhost:3001/docs>      | `API_PORT`         |
| OpenAPI document   | <http://localhost:3001/docs-json> | `API_PORT`         |
| Web dashboard      | <http://localhost:3000>           | `WEB_PORT`         |
| Expo dev server    | port 8081                         | (Expo default)     |
| PostgreSQL         | `localhost:5432` (this PC only)   | `POSTGRES_PORT`    |

What to expect:

- `/health` returns `{"status":"ok","database":"up",...}` with HTTP 200 when PostgreSQL is running.
  If the database is stopped, the API keeps running and `/health` returns HTTP 503 with
  `"database":"down"`.
- The web dashboard shows the HZ logo, the name, "Manager dashboard", and an "API status" card. If
  the API is still starting, the card retries on its own after 2, 4, 8, and 16 seconds; after that
  use "Check again".
- By default the API listens on `127.0.0.1`, so it can be reached from this PC only.
- The API docs exist only in development (`pnpm dev`). A production start does not serve them.

## 4. Try the API

### The acting user (temporary)

There is no sign-in yet. Until Phase 3, the API takes the acting user from a request header:

```text
x-dev-user-id: <the id of a user>
```

This works only when the API runs in development mode (`pnpm dev`) **and** `.env` has
`DEV_AUTH_ENABLED=true`. Without the header, every route except `/health` answers 401. With it, you
act as that user, and **no route checks roles or scope yet**: any user can read and change
everything in their organization. Never expose the API to a network while this is enabled.

### Get a user id

`pnpm db:seed` prints the ids when it creates the demo data. If you no longer have that output,
either open Prisma Studio (`pnpm --filter @ops/api db:studio`, table `User`), or run:

```powershell
docker compose exec postgres psql -U ops -d operations_app -c 'select id, \"displayName\", email from \"User\" order by \"displayName\"'
```

(The quoting is for Windows PowerShell 5.1. Adjust `-U` and `-d` if you changed `POSTGRES_USER` or
`POSTGRES_DB`.) Ids change every time the database is reset.

### In the browser

Open <http://localhost:3001/docs>, press **Authorize**, paste a user id, and use "Try it out" on
any route.

### From PowerShell

```powershell
$api = 'http://localhost:3001'
$headers = @{ 'x-dev-user-id' = '<paste a user id>' }

# Who is in the organization
(Invoke-RestMethod "$api/users?pageSize=100" -Headers $headers).items |
  Format-Table id, displayName, @{ n = 'roles'; e = { $_.memberships.role -join ',' } }

# What the acting user would be allowed to see (not enforced yet)
Invoke-RestMethod "$api/scope/me" -Headers $headers

# Create a work log
$body = @{
  clientId   = [guid]::NewGuid().ToString()
  occurredAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  text       = 'Checked the pump room. All clear.'
} | ConvertTo-Json
$log = Invoke-RestMethod "$api/work-logs" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
$log

# The audit event written in the same transaction
(Invoke-RestMethod "$api/audit-events?entityType=work_log&entityId=$($log.id)" -Headers $headers).items |
  Format-List action, actorType, actorId, correlationId, occurredAt

# The matching domain event in the outbox
(Invoke-RestMethod "$api/outbox-events?aggregateType=work_log&aggregateId=$($log.id)" -Headers $headers).items |
  Format-List eventType, sequence, correlationId, payload
```

What to check:

- The audit event has `action` `work_log.created`, your user id as `actorId`, and the same
  `correlationId` as the outbox event.
- The outbox event has `eventType` `work_log.created` and the work log under `payload.workLog`.
- Sending the same `$body` again returns the same work log (HTTP 200 instead of 201) and adds no
  audit or outbox event.
- An unknown key in a body is rejected with HTTP 400 and names the key.

To record a typed log, list the log types (`GET /log-types`), then send `logTypeId` and
`customFields` with a value for each required field. The rules for lists, errors, and filters are
in [ARCHITECTURE.md](ARCHITECTURE.md#http-conventions).

`Invoke-RestMethod` throws on a non-2xx answer. The error body is in `$_.ErrorDetails.Message`.

## 5. Open the mobile app on your phone (Expo Go)

**Not yet tested on a real phone.** It is planned for Phase 4. The steps below are what it needs.

A phone cannot reach `localhost` on your PC, so the app needs your PC's address on the Wi-Fi
network, and the API must listen on that network.

1. Connect the phone and the PC to the **same Wi-Fi network**. It must be a network you trust and
   one that lets devices see each other (many campus, guest, and office networks do not).
2. Find the PC's Wi-Fi address. Run `ipconfig` and read the "IPv4 Address" of the Wi-Fi adapter.
3. Open `.env` and set:

   ```dotenv
   API_HOST=0.0.0.0
   EXPO_PUBLIC_API_URL=http://<your-pc-wifi-ip>:3001
   ```

   `API_HOST=0.0.0.0` makes the API reachable from the network. While `DEV_AUTH_ENABLED=true`,
   anyone on that network can then act as any user. Set `API_HOST` back to `127.0.0.1` when you
   are done.

4. Allow Node.js through Windows Firewall on ports **8081** (Expo) and **3001** (API). Windows
   normally asks the first time Node listens; choose "Allow" for private networks. To add the rules
   by hand, in PowerShell as Administrator:

   ```powershell
   New-NetFirewallRule -DisplayName "Operations dev (Expo 8081)" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow -Profile Private
   New-NetFirewallRule -DisplayName "Operations dev (API 3001)" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow -Profile Private
   ```

5. Start the API and the mobile dev server, each in its own terminal:

   ```powershell
   pnpm --filter @ops/api dev
   pnpm --filter @ops/mobile dev
   ```

6. Scan the QR code shown in the terminal. On Android, scan it from inside Expo Go. On iPhone, scan
   it with the Camera app.

The app shows the HZ logo and "API reachable" with "Database is up." when everything is connected.
Expo Go shows its own icon and splash screen; the HZ icon and splash appear only in a development
or release build.

If you change an `EXPO_PUBLIC_*` value, stop the mobile dev server and start it again. The values
are built into the app bundle.

## 6. Root scripts

| Command                 | What it does                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `pnpm dev`              | Runs every app in development mode                                                     |
| `pnpm build`            | Builds `packages/shared`, the API, and the web app                                     |
| `pnpm lint`             | Runs ESLint in every package                                                           |
| `pnpm typecheck`        | Runs the TypeScript compiler in every package without emitting files                   |
| `pnpm test`             | Runs every unit test suite                                                             |
| `pnpm test:integration` | Runs the API integration tests against the test database (section 7)                   |
| `pnpm format`           | Formats the whole repository with Prettier                                             |
| `pnpm format:check`     | Checks formatting without changing files                                               |
| `pnpm db:up`            | Starts PostgreSQL in Docker and waits until it is healthy                              |
| `pnpm db:down`          | Stops PostgreSQL. The data is kept in a Docker volume                                  |
| `pnpm db:logs`          | Follows the PostgreSQL logs                                                            |
| `pnpm db:migrate`       | Applies migrations, and creates one when the schema changed (`prisma migrate dev`)     |
| `pnpm db:seed`          | Adds the demo data. Does nothing when the demo organization already exists             |
| `pnpm db:reset`         | **Deletes all data** in the development database, re-applies the migrations, and seeds |

`pnpm db:reset` acts on whatever database `DATABASE_URL` points at and does not ask. Check `.env`
before you run it.

More database commands for the API:

| Command                              | What it does                                          |
| ------------------------------------ | ----------------------------------------------------- |
| `pnpm --filter @ops/api db:generate` | Regenerates the Prisma client                         |
| `pnpm --filter @ops/api db:deploy`   | Applies existing migrations without creating new ones |
| `pnpm --filter @ops/api db:studio`   | Opens Prisma Studio to browse the database            |

To run a script in one package only, add `--filter`, for example `pnpm --filter @ops/web test`.

## 7. Tests

### Unit tests

```powershell
pnpm test
```

| Package           | Test runner           | Test files            |
| ----------------- | --------------------- | --------------------- |
| `packages/shared` | Vitest                | `src/**/*.test.ts`    |
| `apps/api`        | Jest                  | `src/**/*.spec.ts`    |
| `apps/web`        | Vitest                | `src/**/*.test.ts`    |
| `apps/mobile`     | Jest with `jest-expo` | `src/**/*.test.ts(x)` |

The unit tests need no database and no network.

### Integration tests

```powershell
pnpm db:up
pnpm test:integration
```

These start the real API in-process and call it over HTTP against a real PostgreSQL database. They
take about 45 seconds and are not part of `pnpm test`.

- PostgreSQL must be running, and `.env` must have `DATABASE_URL_TEST`.
- The tests create the database `operations_app_test` themselves if it does not exist, and apply
  the migrations to it.
- **They delete all data in that database** between tests. A guard refuses to run unless the
  database name ends in `_test` and is different from the one in `DATABASE_URL`, so the
  development database is never touched.
- Test files are `apps/api/test/*.int-spec.ts`.

## 8. Configuration

All configuration is in the root `.env`. [.env.example](.env.example) lists every variable with a
comment.

| Variable                                                             | Used by           | Purpose                                                                                     |
| -------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Docker Compose    | The local PostgreSQL container                                                              |
| `DATABASE_URL`                                                       | API               | Connection string. Must match the values above                                              |
| `DATABASE_CONNECT_TIMEOUT_MS`                                        | API               | How long to wait for a database connection                                                  |
| `API_HOST`                                                           | API               | `127.0.0.1` (this PC only, the default) or `0.0.0.0` (the network; only for a phone test)   |
| `API_PORT`                                                           | API               | Port the API listens on                                                                     |
| `CORS_ORIGINS`                                                       | API               | Browser origins allowed to call the API                                                     |
| `LOG_LEVEL`                                                          | API               | `verbose`, `debug`, `log`, `warn`, `error`, `fatal`                                         |
| `DEV_AUTH_ENABLED`                                                   | API               | Temporary. `true` lets a caller act as any user with the `x-dev-user-id` header (section 4) |
| `DATABASE_URL_TEST`                                                  | Integration tests | A separate database whose name ends in `_test`                                              |
| `WEB_PORT`                                                           | Web               | Port of the dashboard                                                                       |
| `NEXT_PUBLIC_API_URL`                                                | Web               | API address used by the browser                                                             |
| `NEXT_PUBLIC_BRAND_NAME`                                             | Web               | Product name shown in the dashboard (`HZ`)                                                  |
| `EXPO_PUBLIC_API_URL`                                                | Mobile            | API address used by the phone                                                               |
| `EXPO_PUBLIC_BRAND_NAME`                                             | Mobile            | Product name shown in the app, and the app name on the device (`HZ`)                        |

`NODE_ENV` is not in `.env`. The scripts set it: `pnpm dev` runs the API in `development`, and
`pnpm --filter @ops/api start` runs it in `production`.

The password in `.env.example` is for local development only. Never commit `.env` or real secrets.

## 9. Troubleshooting

| Problem                                                                  | What to do                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`, `pnpm`, or `git` is not recognised                               | Close the terminal and open a new one. If it still fails, reinstall the tool.                                                                                                                                                            |
| `pnpm db:up` fails with a Docker connection error                        | Start Docker Desktop and wait for the engine. If Docker was just installed, restart the computer first.                                                                                                                                  |
| Docker Desktop stopped by itself, and the database is suddenly "down"    | This happened once on 2026-10-13; the cause is unknown. Run `docker desktop restart`, wait for the engine, then `pnpm db:up`. The data is kept.                                                                                          |
| `pnpm db:up` says a variable must be set                                 | `.env` is missing or incomplete. Run `copy .env.example .env`.                                                                                                                                                                           |
| `pnpm db:up` fails because port 5432 is in use                           | Another PostgreSQL is running. Stop it, or change `POSTGRES_PORT` and the port inside `DATABASE_URL` and `DATABASE_URL_TEST`.                                                                                                            |
| The API exits with "Invalid environment configuration"                   | The message names each variable that is missing or wrong. Fix them in `.env`.                                                                                                                                                            |
| `pnpm --filter @ops/api start` exits, naming `DEV_AUTH_ENABLED`          | Intended. `start` runs in production mode, and the API refuses to boot there while `DEV_AUTH_ENABLED=true`. Use `pnpm dev` for development. With the flag set to `false`, a production start answers 401 on everything except `/health`. |
| Every route answers 401 "Authentication is not available yet"            | The API is not in development mode with `DEV_AUTH_ENABLED=true`. Set the flag in `.env` and restart `pnpm dev`. A `pnpm dev` started before `.env` was changed still has the old values.                                                 |
| A route answers 401 and mentions the `x-dev-user-id` header              | Send the header with the id of an existing, non-archived user (section 4). Ids change after `pnpm db:reset`.                                                                                                                             |
| <http://localhost:3001/docs> returns 404                                 | The docs are served only in development mode. Start the API with `pnpm dev`, and restart it if it was started before `.env` changed.                                                                                                     |
| `/health` returns 503 with `"database":"down"`                           | PostgreSQL is not running or `DATABASE_URL` does not match the `POSTGRES_*` values. Run `pnpm db:up`.                                                                                                                                    |
| The API returns 500 and the log says a table does not exist              | The migrations are not applied. Run `pnpm db:migrate`.                                                                                                                                                                                   |
| The web card shows "API unreachable"                                     | Start the API; the card retries by itself for 30 seconds, then use "Check again". Check that `NEXT_PUBLIC_API_URL` is right and that `CORS_ORIGINS` contains the exact address you opened the dashboard from.                            |
| The dashboard or the app shows "Operations" or an old name instead of HZ | The brand variables are read when the dev server starts. Set `NEXT_PUBLIC_BRAND_NAME` and `EXPO_PUBLIC_BRAND_NAME` in `.env` and restart `pnpm dev`.                                                                                     |
| The phone shows "API unreachable"                                        | Check that `API_HOST=0.0.0.0`, that `EXPO_PUBLIC_API_URL` is the PC's Wi-Fi address, that both devices are on the same network, and that the firewall allows ports 8081 and 3001. Then restart the API and the mobile dev server.        |
| Expo Go cannot load the project                                          | Same network and firewall checks as above. Some guest, campus, and office networks block devices from seeing each other; use another network.                                                                                            |
| The phone still uses an old API address                                  | Stop the mobile dev server and run `pnpm --filter @ops/mobile dev --clear`.                                                                                                                                                              |
| Port 3000, 3001, or 8081 is already in use                               | Stop the other program (often an earlier `pnpm dev`), or change `WEB_PORT` or `API_PORT` in `.env`. If you change `API_PORT`, also change both `*_API_URL` values.                                                                       |
| The API stops answering right after `pnpm build`                         | `pnpm build` deletes and rebuilds `apps/api/dist`, which a running `pnpm dev` uses. Restart `pnpm dev`.                                                                                                                                  |
| `pnpm test:integration` says "Refusing to run the integration tests"     | `DATABASE_URL_TEST` is missing, does not end in `_test`, or names the same database as `DATABASE_URL`. Copy the line from `.env.example`.                                                                                                |
| `pnpm db:seed` says the organization already exists                      | Nothing was changed. To start again from an empty database, run `pnpm db:reset` (it deletes all data).                                                                                                                                   |
| `pnpm install` exits with an error about ignored build scripts           | A new dependency wants to run an install script. Decide it under `allowBuilds` in `pnpm-workspace.yaml` (`true` to allow, `false` to deny), then run `pnpm install` again.                                                               |
| An app cannot find `@ops/shared`                                         | Run `pnpm --filter @ops/shared build`. The root scripts do this automatically.                                                                                                                                                           |
| Errors about `src/generated/prisma` in the API                           | Run `pnpm --filter @ops/api db:generate`.                                                                                                                                                                                                |
| "Filename too long" or path errors during install                        | Enable long paths (section 1), then delete `node_modules` and run `pnpm install` again.                                                                                                                                                  |
| To remove the database completely                                        | `docker compose down -v` deletes the database volume, including the test database. Then run `pnpm db:up`, `pnpm db:migrate`, and `pnpm db:seed`.                                                                                         |
