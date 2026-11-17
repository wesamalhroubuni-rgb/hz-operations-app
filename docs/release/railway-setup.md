# Going live on Railway, Cloudflare R2 and hazalang.com

The API, its PostgreSQL database and the manager dashboard run on Railway; photos are stored in
Cloudflare R2; the existing website on `hazalang.com` (Plesk, T-Host) is not touched: only two DNS
records are added.

| Address                      | What                                  |
| ---------------------------- | ------------------------------------- |
| `https://api.hazalang.com`   | The API (the phone app and dashboard) |
| `https://admin.hazalang.com` | The manager dashboard                 |

Keep this page open and do the steps in order. Never paste a secret into a chat or a document.

## 1. Cloudflare R2 (photos)

1. Cloudflare dashboard → **R2 Object Storage**. Activate R2 (a payment method is asked for; the
   first 10 GB a month are free).
2. **Create bucket**: name `hazalang-photos`, location automatic. Leave public access **off**.
3. **R2 → Manage API tokens → Create API token**: permission **Object Read & Write**, restricted to
   the bucket `hazalang-photos`. Create it and keep the page open: it shows the **Access Key ID**,
   the **Secret Access Key** (shown once) and the **endpoint**
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

## 2. Two secrets, generated on your computer

In a terminal on your PC, run this twice (once for each secret) and keep the two outputs for step
4:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The first is `AUTH_ACCESS_TOKEN_SECRET`, the second `AI_KEYS_ENCRYPTION_SECRET`. **Never change
`AI_KEYS_ENCRYPTION_SECRET` later**: the AI keys saved in Settings are encrypted with it.

## 3. Railway project

1. railway.com → **New Project → Deploy from GitHub repo** → `hz-operations-app`. Railway creates a
   service; rename it **api** (Settings → name).
2. In the **api** service → **Settings → Config-as-code → Railway config file**:
   `apps/api/railway.json`.
3. In the project → **Create → Database → PostgreSQL**. It appears as a service named
   **Postgres**.
4. **Create → GitHub Repo** again, the same repository: rename it **web**, and set its config file
   to `apps/web/railway.json`.

## 4. Variables of the api service

**api → Variables → Raw Editor**, paste, then fill in the four marked values:

```text
NODE_ENV=production
RAILPACK_NODE_VERSION=24
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_CONNECT_TIMEOUT_MS=10000
API_HOST=0.0.0.0
API_PORT=8080
LOG_LEVEL=log
TRUST_PROXY_HOPS=1
CORS_ORIGINS=https://admin.hazalang.com
WEB_APP_URL=https://admin.hazalang.com
AUTH_ACCESS_TOKEN_SECRET=<the first secret from step 2>
AI_KEYS_ENCRYPTION_SECRET=<the second secret from step 2>
STORAGE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
STORAGE_PUBLIC_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_BUCKET=hazalang-photos
STORAGE_ACCESS_KEY_ID=<R2 Access Key ID>
STORAGE_SECRET_ACCESS_KEY=<R2 Secret Access Key>
STORAGE_FORCE_PATH_STYLE=true
PUSH_ENABLED=true
OUTBOX_CONSUMER_ENABLED=true
AI_PROVIDER=auto
AI_SUMMARY_SCHEDULER_ENABLED=true
```

Then **api → Settings → Networking → Custom Domain**: `api.hazalang.com`, port `8080`. Railway
shows a **CNAME** target (something like `xxxx.up.railway.app`): keep it for step 6.

## 5. Variables of the web service

**web → Variables → Raw Editor**:

```text
NODE_ENV=production
RAILPACK_NODE_VERSION=24
NEXT_PUBLIC_API_URL=https://api.hazalang.com
NEXT_PUBLIC_ORGANIZATION_SLUG=hazalang
NEXT_PUBLIC_BRAND_NAME=HZ
```

`NEXT_PUBLIC_*` values are built into the dashboard: after changing one, redeploy the web service.
Then **web → Settings → Networking → Custom Domain**: `admin.hazalang.com` (Railway picks the
port). Keep its CNAME target too.

## 6. DNS in Plesk

Plesk → **Websites & Domains → hazalang.com → DNS Settings → Add Record**, twice:

| Type  | Domain name           | Value                      |
| ----- | --------------------- | -------------------------- |
| CNAME | `api.hazalang.com.`   | the api target from step 4 |
| CNAME | `admin.hazalang.com.` | the web target from step 5 |

Railway may also ask for a **TXT** record to prove the domain is yours: add it the same way. Then
**Update**. Within minutes to a few hours Railway shows both domains as active, with https.

## 7. First check

- `https://api.hazalang.com/health` answers `{"status":"ok", ...}`.
- `https://admin.hazalang.com` shows the sign-in page.

If a deploy fails, open the service → **Deployments → View logs** and send the last lines (they
never contain secrets).

## 8. The real organization (no demo data)

Run `pnpm db:bootstrap` once against the production database (ADR-0013), with
`BOOTSTRAP_ORG_SLUG=hazalang` (the same as `NEXT_PUBLIC_ORGANIZATION_SLUG`). We do this step
together once steps 1 to 7 work; the administrator's password is typed only by you.

## 9. Then the Android app

`EXPO_PUBLIC_API_URL=https://api.hazalang.com` and `EXPO_PUBLIC_ORGANIZATION_SLUG=hazalang` in the
Expo production environment, and the build steps of [android-release.md](android-release.md).
