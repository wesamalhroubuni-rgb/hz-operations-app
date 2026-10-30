# apps/mobile memory

Package `@ops/mobile`. Last updated: 2026-10-28.

## Purpose

The worker app for iOS and Android, from one React Native codebase with Expo. Workers log work
with text, photos, location, and the custom fields of each log type, see and update their tasks,
and get notifications, online or offline. Voice later.

## Current state

Phase 4 committed (`280c50a`); Phase 5 (offline mode and sync, ADR-0008) committed (`2cf5a01`).
Phase 6 (2026-10-28) touched the app only to re-export the moved translation core and add one
catalogue key; no screen changed. **Never run on a real phone or in the emulator** (Expo Go or a
build): no screen, camera, location, SecureStore, SQLite, NetInfo, background task, or push
behaviour has been seen on a device. The emulator test is in README section 6, the phone test in
section 5.

- **Offline layer** (`src/offline/`, ADR-0008):
  - One SQLite database per user, `ops-<userId>.db` (`sqliteDatabase.ts`, `db.ts`): cache tables
    per resource (`cache_tasks`, `cache_log_types`, `cache_sites`, `cache_teams`,
    `cache_work_logs`, `cache_notifications`), `meta` (cursor, last refreshed, organization), and
    `queue`; migrations by `PRAGMA user_version`, append-only.
  - `localStore.ts`: the read cache, `applyPull` in one transaction (prune by `ids`).
  - `writeQueue.ts`: the durable queue (`createWorkLog`, `updateWorkLog`, `changeWorkLogStatus`,
    `changeTaskStatus`, `uploadAttachment`), per-record order by `recordKey`, coalescing of unsent
    edits, `rebaseVersion`, `markSending` returns the current copy, `linkServerId` keeps the
    clientId-to-server-id link with the queue, retry, discard (not while sending), resubmit as new,
    copy text.
  - `photoStore.ts` / `expoPhotoFiles.ts`: `offline-photos/<userId>/<localId>.jpg`, 500 MB limit,
    warning at 80%, orphans swept at open.
  - `engine.ts` (+ `engineErrors.ts`, `engineRetry.ts`, `engineNotices.ts`, `engineApp.ts`): one
    run at a time; sends the queue with `offlineSyncHeaders`, then pulls; triggers start,
    foreground, reconnect (`network.ts`, NetInfo; unknown counts as online), after a write,
    "Sync now", timer, background; backoff 2 s doubling to 15 minutes with full jitter, no attempt
    limit; refused refresh → `needsSignIn`.
  - `background.ts`: `expo-background-task`, at most every 15 minutes, development build only;
    unregistered at sign-out.
  - `identity.ts`, `lifecycle.ts`, `session.ts`, `runtime.ts`: the offline identity in
    SecureStore (opens signed in when the server is unreachable), sign-out choices (`syncFirst`,
    `keepForLater`, `discard`), the kept-users register `ops.offline.keptUsers` and the start-up
    sweep (only explicit "keep for later" users, after 30 days), user switch.
  - `legacyUploads.ts`: migrates the Phase 4 AsyncStorage upload queue into the write queue.
  - `localView.ts`: the cache with queued writes applied on top (a queued create appears with its
    `clientId` as id).
- **Sync UI**: `SyncProvider` (`useSync()`), `SyncIndicator` in the header, `SyncBanner`,
  `SyncNotices` (dropped links, photo storage), `SyncStateBadge` per log, `SyncSignOutDialog`,
  `SyncScreen` (stack route `Sync`); texts in `en.ts` under `sync` with one reason per API error
  code (`i18n/syncText.ts`); pure logic in `logic/sync.ts`.

- **Navigation** (React Navigation 7, `src/navigation/`): `App.tsx` picks the navigator from the
  sign-in state (`rootViewFor` in `screen.ts`: loading, signed out, signed in). Signed out: a
  stack with Login and Activate (`SignedOutNavigator.tsx`). Signed in (`SignedInNavigator.tsx`):
  bottom tabs Home, Tasks, Logs, Alerts (the `Notifications` route, with an unread badge), Profile;
  above them a stack with TaskDetail, LogForm (`mode: 'new'`, optionally with a task, or
  `mode: 'edit'`), LogDetail, PhotoViewer, Sync. The map is in `types.ts`. The signed-in tree is
  keyed by user id and wrapped in `SyncProvider`. `navigationRef.ts` holds a target from a
  tapped notification until the navigator is ready.
- **Screens**: Home (tasks due today and overdue first, recent logs, a big "New log" button);
  Tasks (chips Open, Today, Overdue, Done); Task detail (the moves an assignee may make, "Mark as
  blocked" with a required reason, "Update the reason" on a blocked task, "Log work for this
  task"); New/Edit log (log types most-used first, the generated custom-field form with Yes/No
  buttons, select as buttons up to 4 options else a searchable list, a date picker; up to 10
  photos; task, site, team; When; a location card); Logs; Log detail (status, rejection reason,
  edit window, photos with upload progress and Retry, Submit, Resubmit, Edit); Notifications (mark
  read, mark all read); Profile (name, role, organization, push status, sign out, sign out
  everywhere, app version, "Powered by Kaneri.ai"). Login and Activate are the Phase 3 screens
  restyled.
- **Data layer** (`src/data/`): reads through TanStack Query hooks (`queries.ts`,
  `queryKeys.ts`, `DataProvider.tsx`) that read the local store with the queue applied
  (`localView.ts`), invalidated when the store or queue changes; only attachments (signed URLs)
  and the scope still call the server. **Every write goes through `repositories.ts`**: work-log
  creates, edits, and status changes, task status changes, and photos go into the write queue
  first, online or offline, and answer at once (`SavedWorkLog` is `pending` until the sync).
  `notifications.markRead`, `markAllRead`, and push token registration are not queued.
- **Photo uploads** (`uploadQueue.ts`, `src/hooks/useUploads.ts`): since Phase 5 a read-only view
  over the queue's `uploadAttachment` items in the Phase 4 shape, with retry and remove acting on
  the queue. The engine uploads with `uploadAttachment` from `@ops/shared` and a checkpoint per
  photo, so a retry renews the same pending attachment and skips the PUT when only `complete`
  failed.
- **Photos** (`src/device/photos.ts`, `photoSizing.ts`, `files.ts`, `upload.ts`): camera or
  gallery (`expo-image-picker`), resized to 1600 px on the long edge and re-encoded as JPEG at
  0.7 (`expo-image-manipulator`; HEIC becomes JPEG, metadata dropped), moved into the user's
  offline photo folder until the upload completes, PUT with `expo-file-system`'s native upload and
  progress.
- **Location** (`src/device/location.ts`, `locationLogic.ts`): foreground permission, asked once;
  a last-known fix under 2 minutes old, else a fresh high-accuracy fix within 10 s; saved with its
  accuracy; never blocks saving.
- **Drafts and retention** (`src/storage/`): new-log and edit-log forms are drafted per user
  (`ops.drafts.newWorkLog.<userId>`, `ops.drafts.editWorkLog.<userId>.<logId>`). At every app
  start drafts older than 14 days are deleted for every user of the phone (`retention.ts`).
  Queued writes and their photos are never deleted by age (see the offline layer); a user's
  drafts and dropped-link notices are deleted with their offline data.
- **i18n** (`src/i18n/`): every sentence comes from the typed catalogue `en.ts` through `t(key)`;
  `authText.ts`, `errorText.ts`, and `roles.ts` map shared codes to keys. Since Phase 6
  (2026-10-28, ADR-0009) the translation core (`createTranslator`, plurals, `{{name}}`,
  `pickLanguage`, `isRtlLanguage`) lives in `@ops/shared` (`src/i18n/translate.ts`) and
  `src/i18n/translate.ts` only re-exports it; `en.ts` gained the `export_too_large` error text
  (the API error code list is typed, the phone never exports). The language is picked
  from the phone (`expo-localization`) with English as fallback. RTL: styles use `start` / `end`,
  `applyLayoutDirection()` at start-up, `extra.supportsRTL` in `app.config.ts`.
- **Push** (`src/push/`): `pushSupport.ts` decides availability (no push in Expo Go on Android,
  on simulators, or without an EAS project id); `pushService.ts` registers after sign-in and on
  every cold start with a live session, again when the app returns to the foreground after 24
  hours, and unregisters (3 s timeout) before sign-out; `usePush.tsx` wires it to the app state
  and to taps, which open the task or log (`logic/notificationRouting.ts` accepts UUIDs only).
- **Session**: `createAuthSessionManager({ mode: 'mobile' })`, tokens in `expo-secure-store`,
  bearer header. Since Phase 5 `AuthProvider` opens the app signed in from the stored offline
  identity when the server cannot be reached; a refused refresh keeps the queue and the sign-in
  screen names the waiting changes; sign-out with queued items goes through
  `SyncSignOutDialog` (`useSignOut.ts`).
- **Development build**: `expo-dev-client` installed; `eas.json` profile `development`
  (development client, internal distribution, Android APK, no iOS simulator build). Never built.
- **Tests**: 305 unit tests in 26 suites (304 confirmed by the docs-keeper on 2026-10-27, one
  added afterwards as reported), including the engine, queue, store, session, and a full offline
  journey (`offlineJourney.test.ts`) against fakes for SQLite, files, network, clock, and the API
  (`engineTestKit.ts`, `storeTestKit.ts`).

Verified in the Phase 5 session (2026-10-27): lint, typecheck, and tests pass (re-run by the
docs-keeper). Earlier (Phase 4): the repositories ran end to end against the real API outside a
phone; `expo export`; `expo-doctor` 21/21.

## Key files

| File                       | What it does                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | Entry point (`main` in `package.json`). Registers the sync engine (`src/offline/engineRegistration.ts`, which also defines the background task) and `App`.                                                                   |
| `App.tsx`                  | Layout direction, the 14-day draft retention sweep, providers (`SafeAreaProvider`, `AuthProvider`, `DataProvider`, `PushProvider`), the navigator by sign-in state, the navigation theme from the tokens.                    |
| `src/offline/types.ts`     | The offline contracts: `LocalStore`, `WriteQueue`, `QueueItem`, `LocalPhotoStore`, `SyncEngine`, `SyncStatus`, `KEPT_QUEUE_MAX_DAYS`, the photo limit.                                                                       |
| `app.config.ts`            | Expo config: name, identifiers, EAS project id, plugins and iOS permission texts (see below).                                                                                                                                |
| `eas.json`                 | EAS Build profile `development`.                                                                                                                                                                                             |
| `src/data/repositories.ts` | The one write path: writes into the user's queue and answers optimistically.                                                                                                                                                 |
| `src/data/queries.ts`      | All reads (TanStack Query hooks over the local store and queue).                                                                                                                                                             |
| `src/data/uploadQueue.ts`  | Read-only view of the queued photos and their error kinds.                                                                                                                                                                   |
| `src/hooks/useLogForm.ts`  | State of the new and edit log form: custom fields, photos, location, draft, save.                                                                                                                                            |
| `src/logic/`               | Pure logic: `logForm.ts`, `tasks.ts` (filters, allowed moves), `workLogs.ts` (edit window), `dates.ts`, `notificationRouting.ts`.                                                                                            |
| `src/device/`              | Camera and gallery, resizing, local files, upload PUT, location.                                                                                                                                                             |
| `src/push/`                | Push availability, registration lifecycle, provider.                                                                                                                                                                         |
| `src/storage/`             | `keyValueStore.ts` (interface), `deviceStore.ts` (AsyncStorage), `draftStore.ts`, `localPhoto.ts`, `retention.ts`.                                                                                                           |
| `src/i18n/`                | Catalogue, translator, language and RTL.                                                                                                                                                                                     |
| `src/auth/`                | `AuthProvider.tsx`, `token-storage.ts` (SecureStore).                                                                                                                                                                        |
| `src/api/client.ts`        | `authSession` and `apiClient`, both `null` without an API URL; `DEVICE_NAME`.                                                                                                                                                |
| `src/config/env.ts`        | The only place the bundle reads environment variables: `apiUrl`, `brandName`, `organizationSlug`, `easProjectId`.                                                                                                            |
| `src/config/brand.ts`      | `brand`: name, app label, logo, the "Powered by" line.                                                                                                                                                                       |
| `src/components/`          | Large-target UI pieces: `Button`, `FormField`, `CustomFieldInput`, `ChoiceButtons`, `YesNoField`, `PickerField`, `DateTimeField`, `PhotoGrid`, `UploadList`, `FilterChips`, `StateViews`, `ScreenContainer`, `sizes.ts`, ... |
| `jest.config.js`           | `jest-expo` preset; tests are `src/**/*.test.ts(x)`.                                                                                                                                                                         |

## Expo configuration

| Setting                                   | Value                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                    | `EXPO_PUBLIC_BRAND_NAME`, or "Operations" when unset                                                                                                                                                                                                           |
| `slug` / `scheme`                         | `operations-app` / `operationsapp` (not used for deep links yet)                                                                                                                                                                                               |
| iOS `bundleIdentifier`, Android `package` | `EXPO_IOS_BUNDLE_IDENTIFIER` / `EXPO_ANDROID_PACKAGE`, default `ai.kaneri.operations`                                                                                                                                                                          |
| `extra`                                   | `supportsRTL: true`; `eas.projectId` from `EXPO_PUBLIC_EAS_PROJECT_ID` when set                                                                                                                                                                                |
| Plugins                                   | `expo-splash-screen`, `expo-system-ui`, `expo-secure-store`, `expo-image-picker` (camera and photos texts, no microphone), `expo-location` (when in use only, no background), `expo-notifications`, `expo-localization`, `expo-sqlite`, `expo-background-task` |
| `userInterfaceStyle`, background          | `dark`, the `background` token                                                                                                                                                                                                                                 |

Expo Go ignores the config plugins and shows its own icon and splash; they apply to development
and release builds.

## Environment variables

| Variable                                             | Notes                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_API_URL`                                | Base URL of the API, inlined into the bundle. On a phone: `http://<PC address>:3001`. |
| `EXPO_PUBLIC_BRAND_NAME`                             | Product name; also read by `app.config.ts`.                                           |
| `EXPO_PUBLIC_ORGANIZATION_SLUG`                      | Sent with every sign-in (`hz-demo`).                                                  |
| `EXPO_PUBLIC_EAS_PROJECT_ID`                         | From `eas init`. Needed for push and EAS Build; empty means no push.                  |
| `EXPO_IOS_BUNDLE_IDENTIFIER`, `EXPO_ANDROID_PACKAGE` | Read by `app.config.ts` only. Empty means `ai.kaneri.operations` (placeholder).       |

Photos also need the API's `STORAGE_PUBLIC_ENDPOINT` to be reachable from the phone (signed URLs
name it).

## Scripts

Run from the repo root as `pnpm --filter @ops/mobile <script>`.

| Script                   | Command                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `dev`                    | `expo start --go` with the root `.env` (Expo Go)                   |
| `dev:client`             | `expo start --dev-client` with the root `.env` (development build) |
| `android` / `ios`        | `expo start --go --android` / `--ios`                              |
| `lint`                   | `eslint .`                                                         |
| `typecheck`              | `tsc --noEmit`                                                     |
| `test`                   | `jest`                                                             |
| `eas-build-post-install` | `pnpm --filter @ops/shared build` (run by EAS Build)               |

There is no `build` script by design; Turbo skips this package for `pnpm build`. The development
build is made with `eas build --profile development --platform android` from this folder (README
section 5).

## Conventions

- **Every write through `src/data/repositories.ts` into the write queue.** Screens and hooks never
  call `apiClient`, the queue, or the engine to change data; reads go through
  `src/data/queries.ts`; sync state through `useSync()`.
- **Per-user data only**: never open, read, or send another user's database, photo folder, or
  drafts. Never delete a queued write silently (only accepted, discarded by the worker, or the
  explicit kept-queue rule).
- A new API error code needs a `sync.reasons` text in `en.ts`.
- **Every user-facing string through `src/i18n`** (`t('...')`); no English in screens. Styles use
  `start` / `end`, never `left` / `right`.
- **Tokens and the offline identity only in SecureStore**; form drafts, the kept-users register,
  and dropped-link notices in AsyncStorage through `KeyValueStore`; drafts deleted after 14 days.
- Logic that decides something lives in `src/logic/`, `src/data/`, `src/device/*Logic.ts`, or
  `src/push/pushSupport.ts`/`pushService.ts`, returns typed results, and is unit tested without a
  device. Custom-field form logic and the upload flow live in `@ops/shared`.
- Never log a signed URL (its query string is a credential) or a push token.
- **Never write a client name in a screen.** Read `brand` from `src/config/brand.ts`.
- **Never write a colour, spacing, radius, or font size literal in a style.** Import the tokens;
  touch sizes are in `src/components/sizes.ts`.
- Read environment variables only in `src/config/env.ts` (and `app.config.ts`), with static dot
  notation. `DEFAULT_BRAND_NAME` exists in both; change both.
- `@ops/shared` must be built before any Expo command, because `app.config.ts` imports it.
- Relative imports only; no path alias.
- Keep `expo` (~57.0.31), `react-native` (0.86.3), `react` (exactly 19.2.3), and every `expo-*`
  package on the versions Expo SDK 57 expects (`npx expo install --check`).

## Known issues

- **Not run on a phone or in the emulator.** The offline layer is covered only by fakes.
  Accessibility (screen reader, dynamic type), sunlight readability, and glove use are unchecked.
- **Android Expo Go has no remote push** (since SDK 53) and no background task; both need the
  development build, which has never been built. iOS Expo Go can receive push with an EAS
  project id.
- The local database and photos are not encrypted beyond the OS sandbox (ADR-0008).
- The first sign-in needs the server. Logs older than 30 days and photos already on the server
  need a connection.
- A user replaced on the phone while their session had expired keeps their queue until they sign
  in again (never swept automatically).
- No activation deep links: activation links open the web page.
- An Arabic (RTL) catalogue switches the layout only after the next app start.
- The bundle identifiers are placeholders until the owner decides.
- No `metro.config.js` or `babel.config.js`; Expo's defaults handle the pnpm layout.
- The ESLint config sets `settings.react.version` to `'19.2'` by hand. Bump it when React changes.
- Changing an `EXPO_PUBLIC_*` value needs a dev server restart with `--clear`.
- `expo start --tunnel` does not work (no `@expo/ngrok`).
- No component or screen tests; the logic modules are tested.
