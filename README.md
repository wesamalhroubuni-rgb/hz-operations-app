# HZ

Workers log their work from their phones. Supervisors and managers monitor it on a web dashboard.
A later AI layer will summarise the work, flag anomalies, and propose actions for a human to
approve.

**HZ** is the client's product. It is built and powered by Kaneri.ai. The repository folder
(`Operations_App`), the package names (`@ops/*`), and the database (`operations_app`) keep the
technical name "Operations". The name shown in the apps comes from configuration, so the same code
can be deployed for another client.

**Status (2026-10-17)**: Phase 4, the mobile worker app, code complete and waiting for the first
test on a real phone. Workers sign in on the phone, see and update their tasks, and create work
logs with text, photos, location, and custom fields; they get in-app (and, in a development build,
push) notifications when a task is assigned or a log is approved or rejected. Photos are stored in
S3-compatible storage (MinIO in development). The web app still has only sign-in and a placeholder
home page. See [ROADMAP.md](ROADMAP.md).

This guide is for a developer on Windows 11 using PowerShell.

## What is in the repository

| Path              | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`        | REST API (NestJS, Prisma, PostgreSQL), including sign-in and permissions                     |
| `apps/web`        | Manager dashboard (Next.js)                                                                  |
| `apps/mobile`     | Worker app for iOS and Android (React Native, Expo)                                          |
| `packages/shared` | Validation schemas, the typed API client, the sign-in session manager, and the design tokens |
| `packages/config` | Shared ESLint, Prettier, and TypeScript settings                                             |
| `docs/decisions`  | Architecture Decision Records                                                                |
| `docs/brand`      | The client's logo files                                                                      |

More documentation:

- [ARCHITECTURE.md](ARCHITECTURE.md): how the system is structured, the data model, sign-in, and
  the permissions matrix
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
| Docker Desktop | With the WSL 2 backend     | Running PostgreSQL and MinIO    |
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
   one file. `AUTH_ACCESS_TOKEN_SECRET` in `.env.example` is a development placeholder; the API
   refuses to start in production with it.
2. **`pnpm install`** installs all packages and generates the Prisma client.
3. **`pnpm db:up`** starts PostgreSQL and MinIO (the photo storage) in Docker and waits until both
   are healthy. Docker Desktop must be running. The API creates the photo bucket by itself the
   first time it starts in development.
4. **`pnpm db:migrate`** creates the tables.
5. **`pnpm db:seed`** adds demo data: one organization ("HZ Demo", slug `hz-demo`), 2 sites,
   3 teams, 10 users in every role with development passwords, 3 log types, 8 tasks, and 25 work
   logs over the past 14 days. It prints each user's name, roles, and sign-in identifiers. It
   never prints a password. Running it again changes nothing.

To check that everything is in order:

```powershell
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

### Updating an existing checkout to Phase 4

Phase 4 added photo storage, notifications, and the worker app. After pulling it:

1. **Add the new variables to your `.env`.** Compare it with `.env.example`: the `MINIO_*`,
   `STORAGE_*`, `UPLOAD_*`, `DOWNLOAD_URL_TTL_SECONDS`, `EXPO_ACCESS_TOKEN`, `PUSH_ENABLED`,
   `OUTBOX_*`, `EXPO_PUBLIC_EAS_PROJECT_ID`, `EXPO_IOS_BUNDLE_IDENTIFIER`, and
   `EXPO_ANDROID_PACKAGE` variables are new. The API does not start without the `STORAGE_*` ones,
   and Docker Compose needs `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`.
2. Run `pnpm install` (new packages: the AWS S3 client and `sharp` in the API; React Navigation,
   TanStack Query, AsyncStorage, and several Expo modules in the mobile app).
3. Run `pnpm db:up`. It starts the MinIO container next to PostgreSQL. If you already ran MinIO
   during the Phase 4 work, **the next `pnpm db:up` recreates the MinIO container**, because the
   image is now pinned by digest; the photos stay in the `minio_data` volume.
4. Run `pnpm db:migrate` (migration `20261017090000_phase4_mobile`). No reset is needed; the
   Phase 3 seed keeps working.
5. Restart `pnpm dev`.

A checkout from before Phase 3 also needs the Phase 3 variables (`AUTH_*`, `WEB_APP_URL`,
`TRUST_PROXY_HOPS`, the organization slugs) and one `pnpm db:reset` (it deletes all data in the
development database and seeds again; an AI agent cannot run it for you).

## 3. Run the apps

### Everything at once

```powershell
pnpm dev
```

This starts the API, the web dashboard, the Expo dev server, and a watcher that rebuilds
`packages/shared`. Press `Ctrl+C` to stop.

**Restart `pnpm dev` after changing `.env`.** A running process keeps the values it started with,
including the brand name, the allowed origins, and the auth settings.

### One app at a time

Use a separate terminal for each.

```powershell
pnpm --filter @ops/api dev
pnpm --filter @ops/web dev
pnpm --filter @ops/mobile dev
```

Running the mobile app in its own terminal is the easier way to see the QR code and use Expo's
keyboard shortcuts. `pnpm --filter @ops/mobile dev` serves Expo Go; `pnpm --filter @ops/mobile
dev:client` serves the development build instead (section 5).

### URLs and ports

| What               | URL                               | Variable in `.env`   |
| ------------------ | --------------------------------- | -------------------- |
| API health check   | <http://localhost:3001/health>    | `API_PORT`           |
| API docs (Swagger) | <http://localhost:3001/docs>      | `API_PORT`           |
| OpenAPI document   | <http://localhost:3001/docs-json> | `API_PORT`           |
| Web dashboard      | <http://localhost:3000>           | `WEB_PORT`           |
| Expo dev server    | port 8081                         | (Expo default)       |
| PostgreSQL         | `localhost:5432` (this PC only)   | `POSTGRES_PORT`      |
| MinIO (S3 API)     | <http://localhost:9000>           | `MINIO_PORT`         |
| MinIO console      | <http://localhost:9001>           | `MINIO_CONSOLE_PORT` |

What to expect:

- `/health` returns `{"status":"ok","database":"up",...}` with HTTP 200 when PostgreSQL is running.
  If the database is stopped, the API keeps running and `/health` returns HTTP 503 with
  `"database":"down"`.
- The web dashboard sends you to `/login`. After signing in it shows the HZ logo, your name, your
  role, your organization, "Sign out", "Sign out everywhere", and the "API status" card.
- Every API route except `/health`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`,
  and `POST /auth/set-password` needs a signed-in user.
- By default the API, PostgreSQL, and MinIO listen on `127.0.0.1`, so they can be reached from
  this PC only. The MinIO console (sign in with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from
  `.env`) shows the bucket `hz-attachments`; photos are private and reach the apps only through
  short-lived signed URLs.
- The API docs exist only in development (`pnpm dev`). A production start does not serve them.

## 4. Sign in and try the API

### The seeded users

The demo seed creates these users in the organization `hz-demo`. Every user has the development
password of their highest role. **The passwords are defined in one place only: the `DEV_PASSWORDS`
constant in `apps/api/src/operations/seed/demo-seed.ts`.** They are never printed and are not
repeated in any document. In production the seed sets no passwords.

| Role (scope)                                       | Name          | Sign in with (username or email)     | Password                   |
| -------------------------------------------------- | ------------- | ------------------------------------ | -------------------------- |
| admin (whole organization)                         | Aylin Demir   | `aylin` or `aylin.demir@example.com` | `DEV_PASSWORDS.admin`      |
| manager (whole organization)                       | Murat Kaya    | `murat` or `murat.kaya@example.com`  | `DEV_PASSWORDS.manager`    |
| supervisor (site North Depot)                      | Selin Aydin   | `selin`                              | `DEV_PASSWORDS.supervisor` |
| supervisor (site Harbour Project + team Logistics) | Emre Sahin    | `emre`                               | `DEV_PASSWORDS.supervisor` |
| worker (teams Electrical + Maintenance)            | Deniz Yilmaz  | `deniz`                              | `DEV_PASSWORDS.worker`     |
| worker (North Depot, Electrical)                   | Can Ozturk    | `can.o`                              | `DEV_PASSWORDS.worker`     |
| worker (North Depot, Maintenance)                  | Zeynep Arslan | `zeynep`                             | `DEV_PASSWORDS.worker`     |
| worker (Harbour Project, Logistics), no email      | Burak Celik   | `burak` or his phone number          | `DEV_PASSWORDS.worker`     |
| worker (team Logistics)                            | Elif Dogan    | `elif`                               | `DEV_PASSWORDS.worker`     |
| worker (Harbour Project, Maintenance), no email    | Kerem Polat   | `kerem` or his phone number          | `DEV_PASSWORDS.worker`     |

Every user with an email can also sign in with it (`firstname.lastname@example.com`). The two
phone-only users' numbers are in the same seed file and in the seed's output; type them with or
without spaces. Names and addresses are invented.

### In the browser

Open <http://localhost:3000>. You are sent to `/login`. Type an identifier from the table and the
password, then "Sign in". The home page shows your name, role, and organization. "Sign out" ends
this browser's session; "Sign out everywhere" ends every session of the user, on every device.

### From PowerShell (as the mobile app does)

A `mobile` sign-in returns the tokens in the body; send the access token as a bearer token. It
expires after 15 minutes; renew it with the refresh token (each refresh token works once).

```powershell
$api = 'http://localhost:3001'
$password = Read-Host 'Password (see DEV_PASSWORDS in apps/api/src/operations/seed/demo-seed.ts)'
$body = @{ identifier = 'aylin'; password = $password; client = 'mobile'; organizationSlug = 'hz-demo' } | ConvertTo-Json
$session = Invoke-RestMethod "$api/auth/login" -Method Post -ContentType 'application/json' -Body $body
$headers = @{ Authorization = "Bearer $($session.tokens.accessToken)" }

# Who am I
(Invoke-RestMethod "$api/auth/me" -Headers $headers).user

# What I may see (my resolved scope)
Invoke-RestMethod "$api/scope/me" -Headers $headers

# Users, in the shape my role is entitled to (basic, contact or full)
(Invoke-RestMethod "$api/users?pageSize=100" -Headers $headers).items |
  Format-Table id, displayName, profile, @{ n = 'roles'; e = { $_.roles -join ',' } }

# Create a work log (the author is always the signed-in user)
$log = @{
  clientId   = [guid]::NewGuid().ToString()
  occurredAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  text       = 'Checked the pump room. All clear.'
} | ConvertTo-Json
$created = Invoke-RestMethod "$api/work-logs" -Method Post -Headers $headers -ContentType 'application/json' -Body $log

# The audit event of that write (admins only)
(Invoke-RestMethod "$api/audit-events?entityType=work_log&entityId=$($created.id)" -Headers $headers).items |
  Format-List action, actorType, actorId, correlationId, occurredAt

# Renew the session when the access token has expired (the old refresh token is used up)
$session = Invoke-RestMethod "$api/auth/refresh" -Method Post -ContentType 'application/json' -Body (@{ refreshToken = $session.tokens.refreshToken } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($session.tokens.accessToken)" }

# Sign out of this "device"
Invoke-RestMethod "$api/auth/logout" -Method Post -ContentType 'application/json' -Body (@{ refreshToken = $session.tokens.refreshToken } | ConvertTo-Json)
```

`Invoke-RestMethod` throws on a non-2xx answer. The error body is in `$_.ErrorDetails.Message`.
Sign in as different roles and compare: a worker gets 403 on `GET /audit-events` and sees only
their own work logs; a supervisor sees the logs of their scope; a log outside your scope answers
404, exactly like one that does not exist. The full matrix is in
[ARCHITECTURE.md](ARCHITECTURE.md#permissions-matrix).

### In Swagger

Open <http://localhost:3001/docs>. Run `POST /auth/login` with `"client": "mobile"` (Try it out),
copy `tokens.accessToken` from the answer, press **Authorize**, paste it, and use "Try it out" on
any route. Repeat with a worker and a supervisor to see what each may do: the same route answers
200, 403, or 404 depending on the role and scope.

### Create a user and activate them

There is no public sign-up. An admin creates the user, gives them a role with a membership, and
passes on the one-time activation code. Email and SMS delivery are not built: **in development
only**, the code and a ready-made link are in the API's answer and in the API log.

```powershell
# As an admin ($headers from the admin sign-in above)
$newUser = Invoke-RestMethod "$api/users" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ displayName = 'Test Worker'; username = 'test.worker' } | ConvertTo-Json)
$newUser.activation          # purpose, expiresAt, and in development: code and link

$site = (Invoke-RestMethod "$api/sites" -Headers $headers).items[0]
$membership = @{ userId = $newUser.id; role = 'worker'; siteIds = @($site.id) } | ConvertTo-Json
Invoke-RestMethod "$api/memberships" -Method Post -Headers $headers -ContentType 'application/json' -Body $membership
```

Then open the `link` in a browser (it goes to <http://localhost:3000/activate>), or type the code
there, and choose a password (at least 10 characters, not containing the user's name or
identifiers, not a well-known password). The code works once and expires after 72 hours. Then sign
in with `test.worker`.

- A new activation code (the first one expired or was lost): `POST /users/:id/activation-code`.
- A password reset for a user who has signed in before: `POST /users/:id/password-reset`. The
  reset code works on the same `/activate` page and expires after 60 minutes. Setting a password
  ends every session of the user and lifts a lockout.
- Manager and admin memberships must be organization-wide: send `orgWide = $true` and no sites or
  teams.

### Approve or reject a work log (as a supervisor)

There are no approval screens yet (the web dashboard is Phase 6). Sign in as `selin` (or `emre`,
`murat`, `aylin`) in Swagger or PowerShell and call `PATCH /work-logs/{id}/status`:

```powershell
# $headers from a supervisor's sign-in; $logId from GET /work-logs
Invoke-RestMethod "$api/work-logs/$logId/status" -Method Patch -Headers $headers -ContentType 'application/json' -Body (@{ status = 'approved' } | ConvertTo-Json)
Invoke-RestMethod "$api/work-logs/$logId/status" -Method Patch -Headers $headers -ContentType 'application/json' -Body (@{ status = 'rejected'; note = 'Please add a photo of the panel.' } | ConvertTo-Json)
```

A rejection needs a `note` (the worker sees it as the reason). Nobody approves their own log. The
author gets a notification within a few seconds (the in-app list, plus a push in a development
build). `GET /notifications` shows a user's own list.

### Manual checks still open from Phase 3

The owner confirmed sign-in for `aylin`, `selin`, and `deniz` on 2026-10-17. Not yet recorded:

1. In Swagger, compare the three roles on `GET /users`, `GET /work-logs`, `GET /audit-events`, and
   `GET /memberships` (worker: own logs, basic profiles, 403 on audit and memberships).
2. Create a user as the admin, activate them through `/activate`, and sign in as them.
3. Lockout: five wrong passwords for one user lock the account for 15 minutes; the right password
   is then refused with the same message. An admin password reset lifts the lock.
4. Sign in on two browsers (or a browser and PowerShell), press "Sign out everywhere" in one, and
   check that the other is signed out on its next request.

## 5. Test on my phone

**Not yet done on a real phone** (as of 2026-10-17). Everything below is what it needs.

A phone cannot reach `localhost` on your PC. It needs the PC's address for three things: the API
(port 3001), the Expo dev server (port 8081), and MinIO (port 9000), because photos are uploaded
to and downloaded from MinIO directly, through signed URLs that the API writes with the address in
`STORAGE_PUBLIC_ENDPOINT`.

### Expo Go or the development build

| What                                                       | Expo Go                | Development build                         |
| ---------------------------------------------------------- | ---------------------- | ----------------------------------------- |
| Sign-in, tasks, work logs, photos, location, in-app alerts | yes                    | yes                                       |
| Push notifications on Android                              | **no** (since SDK 53)  | yes                                       |
| Push notifications on iPhone                               | yes, with a project id | yes (needs an Apple developer account)    |
| HZ icon and splash screen                                  | no (Expo's own)        | yes                                       |
| Setup                                                      | install from the store | an Expo account and one EAS build (below) |

Start with Expo Go: everything except push on Android works there, and the in-app notification
list (the Alerts tab) works in every case.

### Set up the network (phone hotspot)

The campus Wi-Fi blocks phone-to-PC traffic, so connect the PC to the phone's hotspot.

1. Turn on the hotspot on the phone and connect the PC to it. In Windows Settings, Network &
   internet, Wi-Fi, open the hotspot network's properties and set **Network profile type** to
   **Private** (the firewall rules below apply to private networks only).
2. Find the PC's address on the hotspot: run `ipconfig` and read the "IPv4 Address" of the Wi-Fi
   adapter (for example `192.168.x.y` or `172.20.x.y`). Below it is written `<IP>`.
3. Open `.env` and change these four lines (keep a copy of the old values):

   ```dotenv
   API_HOST=0.0.0.0
   EXPO_PUBLIC_API_URL=http://<IP>:3001
   STORAGE_PUBLIC_ENDPOINT=http://<IP>:9000
   MINIO_BIND_HOST=0.0.0.0
   ```

   - `API_HOST=0.0.0.0` makes the API listen on every network of the PC, not only on this PC. The
     demo accounts have well-known development passwords, and in development the API docs
     (`/docs`) are then reachable from that network too, so do this only on your own hotspot and
     switch back afterwards.
   - `STORAGE_PUBLIC_ENDPOINT` is the address written into signed photo URLs; the phone must be
     able to reach it. `MINIO_BIND_HOST=0.0.0.0` publishes MinIO's port 9000 on the network (the
     MinIO console stays on `127.0.0.1`).

4. Recreate MinIO with the new binding: `pnpm db:up`.
5. Start the apps (stop any running `pnpm dev` first), each in its own terminal:

   ```powershell
   pnpm --filter @ops/api dev
   pnpm --filter @ops/mobile dev --clear
   ```

   `--clear` makes Expo rebuild the bundle with the new `EXPO_PUBLIC_API_URL`.

6. **Windows Firewall**: when Windows asks, allow **Node.js** (ports 3001 and 8081) and **Docker
   Desktop** (port 9000) on **Private networks only**. If you missed the prompts, add the rules in
   PowerShell as Administrator:

   ```powershell
   New-NetFirewallRule -DisplayName "Operations dev (API 3001)" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow -Profile Private
   New-NetFirewallRule -DisplayName "Operations dev (Expo 8081)" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow -Profile Private
   New-NetFirewallRule -DisplayName "Operations dev (MinIO 9000)" -Direction Inbound -Protocol TCP -LocalPort 9000 -Action Allow -Profile Private
   ```

7. Check from the phone's browser: `http://<IP>:3001/health` should show `"status":"ok"`.
8. Open Expo Go and scan the QR code from the Expo terminal (on Android inside Expo Go, on iPhone
   with the Camera app).

### Try it

1. Sign in as `deniz` (worker; password `DEV_PASSWORDS.worker` in
   `apps/api/src/operations/seed/demo-seed.ts`). Allow location and, when you add a photo, camera
   or photos.
2. Tasks tab: open a task and press "Start work" or "Mark as blocked" (a reason is required).
3. "New log": pick a log type, fill its fields, add a photo, set the site to **North Depot** (so
   `selin` can see it), save. The photo uploads with a progress bar; the log appears under Logs.
4. Open the log and edit it (allowed within the edit window while it is not approved).
5. Approve or reject it as `selin` in Swagger on the PC (section 4, "Approve or reject a work
   log"). Within a few seconds `deniz` sees it in the Alerts tab (pull to refresh, or wait up to a
   minute), and in a development build gets a push.
6. Profile: "Sign out".

### Switch everything back afterwards

1. In `.env`, restore:

   ```dotenv
   API_HOST=127.0.0.1
   EXPO_PUBLIC_API_URL=http://localhost:3001
   STORAGE_PUBLIC_ENDPOINT=http://localhost:9000
   MINIO_BIND_HOST=127.0.0.1
   ```

2. Run `pnpm db:up` (MinIO goes back to `127.0.0.1`).
3. Restart the API (or `pnpm dev`) and start Expo with `--clear` once.
4. Optionally remove the firewall rules
   (`Remove-NetFirewallRule -DisplayName "Operations dev*"` as Administrator) and set the hotspot
   network back to Public.

### The development build (for push on Android)

Push on Android needs a development build: your own installable app with the HZ icon that loads
the JavaScript from your PC like Expo Go does. It is built once on Expo's servers (EAS). **Nobody
has run these steps yet.**

1. Create a free account on <https://expo.dev>.
2. Install the EAS command line and sign in:

   ```powershell
   npm install -g eas-cli
   eas login
   ```

3. Create the EAS project, from `apps\mobile`:

   ```powershell
   cd apps\mobile
   eas init
   ```

   It prints a project id. Put it into the root `.env` as `EXPO_PUBLIC_EAS_PROJECT_ID=<id>` and
   into `apps/mobile/eas.json` under `build.development.env` as
   `"EXPO_PUBLIC_EAS_PROJECT_ID": "<id>"` (or store it on EAS with `eas env:create`).
   `app.config.ts` cannot be edited by `eas init`; it reads the id from that variable.

4. Decide the final app identifiers before any store build (`EXPO_IOS_BUNDLE_IDENTIFIER`,
   `EXPO_ANDROID_PACKAGE`; empty means `ai.kaneri.operations`). They cannot change after a store
   release. A development build can use the default.
5. Build the Android development build, still in `apps\mobile`, with the root `.env` loaded:

   ```powershell
   ..\..\node_modules\.bin\dotenv.cmd -e ..\..\.env -- eas build --profile development --platform android
   ```

   It takes a while on Expo's servers and ends with a link and a QR code for the APK.

6. On the phone, open the link (or scan the QR code), download the APK, and install it (allow
   installing from this source when Android asks).
7. On the PC, serve the development build instead of Expo Go (network settings as above):

   ```powershell
   pnpm --filter @ops/mobile dev:client --clear
   ```

8. Open the HZ app on the phone; it finds the dev server, or scan the QR code from the terminal.
   After sign-in, Profile shows whether push notifications are on.

An iPhone development build needs a paid Apple developer account (`--platform ios`); on iPhone,
push also works in Expo Go once `EXPO_PUBLIC_EAS_PROJECT_ID` is set.

If you change an `EXPO_PUBLIC_*` value, stop the mobile dev server and start it again with
`--clear`. The values are built into the app bundle.

## 6. Root scripts

| Command                 | What it does                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `pnpm dev`              | Runs every app in development mode (start `pnpm db:up` first)                          |
| `pnpm build`            | Builds `packages/shared`, the API, and the web app                                     |
| `pnpm lint`             | Runs ESLint in every package                                                           |
| `pnpm typecheck`        | Runs the TypeScript compiler in every package without emitting files                   |
| `pnpm test`             | Runs every unit test suite                                                             |
| `pnpm test:integration` | Runs the API integration tests against the test database (section 7)                   |
| `pnpm format`           | Formats the whole repository with Prettier                                             |
| `pnpm format:check`     | Checks formatting without changing files                                               |
| `pnpm db:up`            | Starts PostgreSQL and MinIO in Docker and waits until both are healthy                 |
| `pnpm db:down`          | Stops PostgreSQL and MinIO. The data is kept in Docker volumes                         |
| `pnpm db:logs`          | Follows the PostgreSQL logs (MinIO: `docker compose logs -f minio`)                    |
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
The mobile app has `dev` (Expo Go), `dev:client` (the development build), `android`, and `ios`.

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

The unit tests need no database and no network. `apps/api/src/route-policies.spec.ts` fails when
any API route has no policy.

### Integration tests

```powershell
pnpm db:up
pnpm test:integration
```

These start the real API in-process and call it over HTTP against a real PostgreSQL database, with
real sign-ins and sessions. They take about 3 minutes and are not part of `pnpm test`.

- PostgreSQL and MinIO must be running (`pnpm db:up`), and `.env` must have `DATABASE_URL_TEST`.
  Most suites use an in-memory file storage; `storage-minio.int-spec.ts` uses the real MinIO with
  its own bucket `hz-attachments-test`. Push goes to a fake Expo client; nothing is sent to Expo.
- The tests create the database `operations_app_test` themselves if it does not exist, and apply
  the migrations to it.
- **They delete all data in that database** between tests. A guard refuses to run unless the
  database name ends in `_test` and is different from the one in `DATABASE_URL`, so the
  development database is never touched.
- Test files are `apps/api/test/*.int-spec.ts`. `permissions-matrix.int-spec.ts` checks every cell
  of the permissions matrix.

## 8. Configuration

All configuration is in the root `.env`. [.env.example](.env.example) lists every variable with a
comment.

| Variable                                                             | Used by           | Purpose                                                                                                                    |
| -------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Docker Compose    | The local PostgreSQL container                                                                                             |
| `DATABASE_URL`                                                       | API               | Connection string. Must match the values above                                                                             |
| `DATABASE_CONNECT_TIMEOUT_MS`                                        | API               | How long to wait for a database connection                                                                                 |
| `API_HOST`                                                           | API               | `127.0.0.1` (this PC only, the default) or `0.0.0.0` (the network; only for a phone test)                                  |
| `API_PORT`                                                           | API               | Port the API listens on                                                                                                    |
| `CORS_ORIGINS`                                                       | API               | Browser origins allowed to call the API. Also the allow-list of the CSRF check: sign-in from any other origin is refused   |
| `LOG_LEVEL`                                                          | API               | `verbose`, `debug`, `log`, `warn`, `error`, `fatal`                                                                        |
| `TRUST_PROXY_HOPS`                                                   | API               | Number of reverse proxies in front of the API (0 locally). Set it exactly in production                                    |
| `AUTH_ACCESS_TOKEN_SECRET`                                           | API               | Signs access tokens; at least 32 characters. Production refuses placeholder or weak values. Changing it signs everyone out |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`                                      | API               | Access token lifetime (900)                                                                                                |
| `AUTH_REFRESH_TOKEN_TTL_DAYS`, `AUTH_SESSION_ABSOLUTE_TTL_DAYS`      | API               | Session ends after 30 days without use, and after 90 days at the latest                                                    |
| `AUTH_REFRESH_REUSE_GRACE_SECONDS`                                   | API               | A refresh token sent twice within this many seconds (two tabs) does not end the session (10)                               |
| `AUTH_ACTIVATION_CODE_TTL_HOURS`, `AUTH_RESET_CODE_TTL_MINUTES`      | API               | One-time code validity (72 hours, 60 minutes)                                                                              |
| `AUTH_MAX_FAILED_LOGINS`, `AUTH_LOCKOUT_MINUTES`                     | API               | Lockout after 5 failed sign-ins in a row, for 15 minutes                                                                   |
| `AUTH_COOKIE_DOMAIN`                                                 | API               | Leave empty unless the web app and API are on different subdomains of one domain                                           |
| `WEB_APP_URL`                                                        | API               | Address of the web app; activation and reset links point at it. `https://` in production                                   |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`                             | Docker Compose    | MinIO's own login (development only)                                                                                       |
| `MINIO_BIND_HOST`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`                | Docker Compose    | Where MinIO listens: `127.0.0.1`, 9000, 9001. `MINIO_BIND_HOST=0.0.0.0` only for a phone test; the console stays local     |
| `STORAGE_ENDPOINT`                                                   | API               | Where the API reaches the storage (`http://127.0.0.1:9000`)                                                                |
| `STORAGE_PUBLIC_ENDPOINT`                                            | API               | Address written into signed photo URLs; must be reachable by the phone or browser. `https://` in production                |
| `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_FORCE_PATH_STYLE`       | API               | `us-east-1`, `hz-attachments`, `true` (MinIO and most S3-compatible services)                                              |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`                 | API               | Storage credentials. In development the MinIO login; production refuses placeholder or weak secrets                        |
| `UPLOAD_MAX_BYTES`                                                   | API               | Largest photo accepted (10485760 = 10 MiB; at most 25 MiB)                                                                 |
| `UPLOAD_URL_TTL_SECONDS`, `DOWNLOAD_URL_TTL_SECONDS`                 | API               | Lifetime of signed upload and download URLs (300 each)                                                                     |
| `PUSH_ENABLED`, `EXPO_ACCESS_TOKEN`                                  | API               | Send push notifications through Expo (`true`); the token is needed only with Expo's "enhanced push security"               |
| `OUTBOX_CONSUMER_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`                 | API               | Run the background reader that turns events into notifications (`true`, every 2000 ms)                                     |
| `DATABASE_URL_TEST`                                                  | Integration tests | A separate database whose name ends in `_test`                                                                             |
| `WEB_PORT`                                                           | Web               | Port of the dashboard                                                                                                      |
| `NEXT_PUBLIC_API_URL`                                                | Web               | API address used by the browser                                                                                            |
| `NEXT_PUBLIC_BRAND_NAME`                                             | Web               | Product name shown in the dashboard (`HZ`)                                                                                 |
| `NEXT_PUBLIC_ORGANIZATION_SLUG`                                      | Web               | Organization this deployment serves, sent with every sign-in (`hz-demo`)                                                   |
| `EXPO_PUBLIC_API_URL`                                                | Mobile            | API address used by the phone                                                                                              |
| `EXPO_PUBLIC_BRAND_NAME`                                             | Mobile            | Product name shown in the app, and the app name on the device (`HZ`)                                                       |
| `EXPO_PUBLIC_ORGANIZATION_SLUG`                                      | Mobile            | Same as the web variable, for the mobile app                                                                               |
| `EXPO_PUBLIC_EAS_PROJECT_ID`                                         | Mobile            | EAS project id from `eas init`; needed for push. Empty: no push, the in-app list still works                               |
| `EXPO_IOS_BUNDLE_IDENTIFIER`, `EXPO_ANDROID_PACKAGE`                 | Mobile            | App identifiers for builds; empty means `ai.kaneri.operations` (a placeholder until decided)                               |

`NODE_ENV` is not in `.env`. The scripts set it: `pnpm dev` runs the API in `development`, and
`pnpm --filter @ops/api start` runs it in `production`, where the API refuses the placeholder
secrets from `.env.example` (auth and storage), a non-https `WEB_APP_URL` or
`STORAGE_PUBLIC_ENDPOINT`, and a missing bucket.

The passwords and the secret in `.env.example` are for local development only. Never commit `.env`
or real secrets.

## 9. Troubleshooting

| Problem                                                                                  | What to do                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`, `pnpm`, or `git` is not recognised                                               | Close the terminal and open a new one. If it still fails, reinstall the tool.                                                                                                                                                                                                      |
| `pnpm db:up` fails with a Docker connection error                                        | Start Docker Desktop and wait for the engine. If Docker was just installed, restart the computer first.                                                                                                                                                                            |
| Docker Desktop stopped by itself, and the database is suddenly "down"                    | This happened once on 2026-10-13; the cause is unknown. Run `docker desktop restart`, wait for the engine, then `pnpm db:up`. The data is kept.                                                                                                                                    |
| `pnpm db:up` says a variable must be set                                                 | `.env` is missing or incomplete. Run `copy .env.example .env`.                                                                                                                                                                                                                     |
| `pnpm db:up` fails because port 5432 is in use                                           | Another PostgreSQL is running. Stop it, or change `POSTGRES_PORT` and the port inside `DATABASE_URL` and `DATABASE_URL_TEST`.                                                                                                                                                      |
| The API exits with "Invalid environment configuration"                                   | The message names each variable that is missing or wrong (for example the `STORAGE_*` variables after updating to Phase 4). Fix them in `.env`; `.env.example` has every key.                                                                                                      |
| `pnpm --filter @ops/api start` exits, naming `AUTH_ACCESS_TOKEN_SECRET` or `WEB_APP_URL` | Intended. `start` runs in production mode, which refuses the development placeholder secret and a non-https web address. Use `pnpm dev` for development.                                                                                                                           |
| Signing in on the web says "Something went wrong" and the API answered 403               | The page's origin is not in `CORS_ORIGINS`. Add the exact address you opened the dashboard from (for example `http://localhost:3000`), then restart `pnpm dev`.                                                                                                                    |
| Sign-in fails for every seeded user with the right password                              | The development database was seeded before Phase 3 (no usernames, no passwords). Run `pnpm db:reset` once. Check also that `NEXT_PUBLIC_ORGANIZATION_SLUG` is `hz-demo`, and that the account is not locked.                                                                       |
| Sign-in answers 429 "Too many attempts"                                                  | A rate limit was hit (for example 10 attempts per identifier in 5 minutes). Wait the number of seconds in the `Retry-After` header. Restarting the API also clears the limits (they are kept in memory).                                                                           |
| The right password is refused after several wrong ones                                   | The account is locked for 15 minutes after 5 failed sign-ins. The answer is the same as for a wrong password on purpose. Wait, or have an admin issue a password reset (`POST /users/:id/password-reset`).                                                                         |
| Every API call answers 401 "Sign in to continue"                                         | Sign in first. The access token lasts 15 minutes; renew it with `POST /auth/refresh`. A session also ends when the user signs out everywhere, sets a new password, is archived, or loses a membership.                                                                             |
| A call from PowerShell or Swagger answers 403 "refused as a cross-site request"          | You sent the session cookies without a valid `Origin` and `x-csrf-token`. From scripts, sign in with `"client": "mobile"` and use the bearer token instead.                                                                                                                        |
| A route answers 403 "Your role does not allow this"                                      | The signed-in user's role may not use that route at all (see the matrix in ARCHITECTURE.md). A user with no active membership gets this on every route except `/auth/*` and `/scope/me`.                                                                                           |
| A record you know exists answers 404                                                     | It is outside your scope. The API answers exactly as if it did not exist.                                                                                                                                                                                                          |
| The activation code is refused (422)                                                     | It was mistyped, already used, replaced by a newer code, or expired (activation 72 hours, reset 60 minutes). Ask an admin for a new one.                                                                                                                                           |
| <http://localhost:3001/docs> returns 404                                                 | The docs are served only in development mode. Start the API with `pnpm dev`, and restart it if it was started before `.env` changed.                                                                                                                                               |
| `/health` returns 503 with `"database":"down"`                                           | PostgreSQL is not running or `DATABASE_URL` does not match the `POSTGRES_*` values. Run `pnpm db:up`.                                                                                                                                                                              |
| The API returns 500 and the log says a table does not exist                              | The migrations are not applied. Run `pnpm db:migrate`.                                                                                                                                                                                                                             |
| The web card shows "API unreachable"                                                     | Start the API; the card retries by itself for 30 seconds, then use "Check again". Check that `NEXT_PUBLIC_API_URL` is right and that `CORS_ORIGINS` contains the exact address you opened the dashboard from.                                                                      |
| The dashboard or the app shows "Operations" or an old name instead of HZ                 | The brand variables are read when the dev server starts. Set `NEXT_PUBLIC_BRAND_NAME` and `EXPO_PUBLIC_BRAND_NAME` in `.env` and restart `pnpm dev`.                                                                                                                               |
| The phone cannot reach the API (sign-in says the server is unreachable)                  | Check that `API_HOST=0.0.0.0`, that `EXPO_PUBLIC_API_URL` is the PC's hotspot address, that the hotspot network is Private in Windows, and that the firewall allows 3001 and 8081. Open `http://<IP>:3001/health` in the phone's browser. Restart the API and Expo with `--clear`. |
| Expo Go cannot load the project                                                          | Same network and firewall checks as above. If the QR code shows another address (Ethernet, VPN), disconnect that adapter. Campus, guest, and office networks often block devices from seeing each other; use the phone's hotspot.                                                  |
| The phone still uses an old API address                                                  | Stop the mobile dev server and run `pnpm --filter @ops/mobile dev --clear`.                                                                                                                                                                                                        |
| Photos stay at "uploading" or fail on the phone, or thumbnails do not load               | The signed URLs name `STORAGE_PUBLIC_ENDPOINT`: it must be `http://<IP>:9000`, `MINIO_BIND_HOST=0.0.0.0` (then `pnpm db:up`), and port 9000 allowed in the firewall. **After changing it, restart the API**: a running API keeps signing URLs with the old host.                   |
| The storage answers 403 to the photo upload (PUT)                                        | The PUT did not send exactly the signed `Content-Type` and size, or the URL expired (5 minutes). The app retries with a fresh URL; from a script, call `POST /attachments/:id/upload-url` for a new one.                                                                           |
| Upload calls answer 503 "File storage is unavailable"                                    | MinIO is not running or not reachable at `STORAGE_ENDPOINT`. Run `pnpm db:up`. In development the API keeps running without it.                                                                                                                                                    |
| Upload calls answer 429                                                                  | More than 60 upload starts, completions, or renewals by one user in 10 minutes. Wait for `Retry-After`, or restart the API (the limits are in memory).                                                                                                                             |
| No push notification arrives                                                             | Expected in Expo Go on Android (use the development build) and without `EXPO_PUBLIC_EAS_PROJECT_ID`. Profile shows the push status. Check that `PUSH_ENABLED=true`. The in-app list (Alerts tab) works regardless.                                                                 |
| The API exits at start in production naming the bucket                                   | Production never creates the bucket. Create it (private) in the storage provider first.                                                                                                                                                                                            |
| Port 3000, 3001, or 8081 is already in use                                               | Stop the other program (often an earlier `pnpm dev`), or change `WEB_PORT` or `API_PORT` in `.env`. If you change `API_PORT`, also change both `*_API_URL` values; if you change `WEB_PORT`, also `CORS_ORIGINS` and `WEB_APP_URL`.                                                |
| The API stops answering right after `pnpm build`                                         | `pnpm build` deletes and rebuilds `apps/api/dist`, which a running `pnpm dev` uses. Restart `pnpm dev`.                                                                                                                                                                            |
| `pnpm test:integration` says "Refusing to run the integration tests"                     | `DATABASE_URL_TEST` is missing, does not end in `_test`, or names the same database as `DATABASE_URL`. Copy the line from `.env.example`.                                                                                                                                          |
| `pnpm db:seed` says the organization already exists                                      | Nothing was changed. To start again from an empty database, run `pnpm db:reset` (it deletes all data).                                                                                                                                                                             |
| `pnpm install` exits with an error about ignored build scripts                           | A new dependency wants to run an install script. Decide it under `allowBuilds` in `pnpm-workspace.yaml` (`true` to allow, `false` to deny), then run `pnpm install` again.                                                                                                         |
| An app cannot find `@ops/shared`                                                         | Run `pnpm --filter @ops/shared build`. The root scripts do this automatically.                                                                                                                                                                                                     |
| Errors about `src/generated/prisma` in the API                                           | Run `pnpm --filter @ops/api db:generate`.                                                                                                                                                                                                                                          |
| "Filename too long" or path errors during install                                        | Enable long paths (section 1), then delete `node_modules` and run `pnpm install` again.                                                                                                                                                                                            |
| To remove the database completely                                                        | `docker compose down -v` deletes the database and MinIO volumes (all photos too), including the test database. Then run `pnpm db:up`, `pnpm db:migrate`, and `pnpm db:seed`.                                                                                                       |
