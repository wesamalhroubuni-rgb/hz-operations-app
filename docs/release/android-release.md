# Android release checklist

How to take the worker app to Google Play and the dashboard and API to production. Steps marked
**owner** need your accounts or decisions; everything else is in the repo.

## 1. Decisions (owner, before the first store build)

- **Android application id** (`EXPO_ANDROID_PACKAGE`), for example `com.yourcompany.hz`. It can
  never change after the first release. The default `ai.kaneri.operations` is a placeholder.
- **App name** shown on the phone: `EXPO_PUBLIC_BRAND_NAME` (for example `HZ`).
- **Organization slug** of the real organization (used at sign-in), for example `hz`.
- **Production domains**: one for the API (for example `api.example.com`), one for the dashboard,
  one for the file storage. All must be **https**: Android release builds refuse plain http.

## 2. Accounts (owner)

- Google Play Console developer account (one-time fee).
- Expo account for EAS Build. In `apps/mobile`, run `npx eas-cli login`, then `npx eas-cli init`;
  put the printed project id in `EXPO_PUBLIC_EAS_PROJECT_ID` (also enables push notifications).
- Firebase project for Android push (FCM), linked in Expo: `npx eas-cli credentials`.

## 3. Production server

1. PostgreSQL and S3-compatible storage (the bucket must exist; development creates it, production
   does not).
2. API environment: every required variable of `.env.example`, with `NODE_ENV=production`.
   Production refuses placeholder secrets, an http `WEB_APP_URL` or `STORAGE_PUBLIC_ENDPOINT`, and
   `AI_PROVIDER=fake`. Set a strong `AI_KEYS_ENCRYPTION_SECRET` once and never change it.
3. `pnpm --filter @ops/api db:deploy` (migrations), then `pnpm --filter @ops/api build` and
   `pnpm --filter @ops/api start` behind an https proxy (`TRUST_PROXY_HOPS=1`).
4. **The real organization, no demo data**: set the `BOOTSTRAP_*` variables (see `.env.example`)
   and run `pnpm db:bootstrap` once (ADR-0013). Remove `BOOTSTRAP_ADMIN_PASSWORD` afterwards.
   **Never run `pnpm db:seed` against production**: it creates the invented demo organization.
5. Dashboard: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ORGANIZATION_SLUG`, `NEXT_PUBLIC_BRAND_NAME`,
   then `pnpm --filter @ops/web build` and `pnpm --filter @ops/web start` behind https. Put the
   dashboard's origin in the API's `CORS_ORIGINS` and `WEB_APP_URL`.
6. Sign in to the dashboard as the bootstrapped administrator; add sites, teams, log types and
   people (each gets an activation code); paste the organization's AI keys in Settings if wanted.

## 4. The Android build

1. In the Expo dashboard (or `npx eas-cli env:create`), set for the **production** environment:
   `EXPO_PUBLIC_API_URL` (the https API), `EXPO_PUBLIC_ORGANIZATION_SLUG`,
   `EXPO_PUBLIC_BRAND_NAME`, `EXPO_PUBLIC_EAS_PROJECT_ID`, `EXPO_ANDROID_PACKAGE`.
2. A test build to install on phones: `npx eas-cli build -p android --profile preview` (APK).
3. The store build: `npx eas-cli build -p android --profile production` (app bundle; the version
   code goes up by itself).
4. Upload: `npx eas-cli submit -p android --profile production` (to the internal testing track
   as a draft), or upload the `.aab` in Play Console by hand.

## 5. Play Console listing (owner)

- Short and full description, app icon 512×512 (`apps/mobile/assets/brand/icon-1024.png` scaled),
  feature graphic 1024×500, at least two phone screenshots.
- **Privacy policy URL**: publish `docs/release/privacy-policy.md` (fill in the bracketed parts)
  on a public web page.
- **Data safety form**, from what the app really does:
  - Collected: name, email or phone (account), approximate and precise location (saved with a
    work log while the app is open), photos (attached to work logs), audio (voice notes, when
    smart capture is on), app interactions (work logs and tasks).
  - Purpose: app functionality. Not sold, not used for ads.
  - Shared: with the organization that employs the worker; voice notes and photos are processed
    by the AI provider only when the organization turned smart capture on.
  - Encrypted in transit (https). Deletion: on request to the organization's administrator.
- Content rating questionnaire; target audience: adults (workplace app); no ads.
- App access: give Google a test account of a test organization (not production data).

## 6. Before pressing "Release"

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm format:check` pass.
- A preview APK tested on a real phone: sign in, log work with a photo offline and online, a
  task status change, notifications, light and dark, English, Turkish and Arabic.
- The dashboard tested in English, Turkish and Arabic.
