# apps/mobile memory

Package `@ops/mobile`. Last updated: 2026-10-17.

## Purpose

The worker app for iOS and Android, from one React Native codebase with Expo. Workers log work
with text, photos, location, and the custom fields of each log type, see and update their tasks,
and get notifications. Offline work comes in Phase 5; voice later.

## Current state

Phase 4 (mobile worker app) code complete on 2026-10-17, uncommitted. **Never run on a real phone**
(Expo Go or a build): no screen, camera, location, SecureStore, or push behaviour has been seen on
a device. The owner will test over the phone's hotspot (README section 5).

- **Navigation** (React Navigation 7, `src/navigation/`): `App.tsx` picks the navigator from the
  sign-in state (`rootViewFor` in `screen.ts`: loading, signed out, signed in). Signed out: a
  stack with Login and Activate (`SignedOutNavigator.tsx`). Signed in (`SignedInNavigator.tsx`):
  bottom tabs Home, Tasks, Logs, Alerts (the `Notifications` route, with an unread badge), Profile;
  above them a stack with TaskDetail, LogForm (`mode: 'new'`, optionally with a task, or
  `mode: 'edit'`), LogDetail, PhotoViewer. The map is in `types.ts`. The signed-in tree is keyed
  by user id, so another user starts with an empty cache. `navigationRef.ts` holds a target from a
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
- **Data layer** (`src/data/`): reads with TanStack Query (`queries.ts`, `queryKeys.ts`,
  `DataProvider.tsx`; notifications polled every 60 s; attachments refetched 30 s before their
  signed URLs expire). **Every write goes through `repositories.ts`** (`workLogs.create`, `update`,
  `changeStatus`; `tasks.changeStatus`; `attachments.upload`; `notifications.markRead`,
  `markAllRead`, `registerPushToken`, `unregisterPushToken`), each returning a typed `WriteResult`
  (`results.ts`) and updating the cache through `CacheSync`. `create` returns a `SavedWorkLog`
  (`settled` today; `pending` is already handled by screens for Phase 5) and retries once on a
  network failure or timeout (the `clientId` makes it safe).
- **Photo uploads** (`uploadQueue.ts`, `src/hooks/useUploads.ts`): the log is saved first, then
  its photos are uploaded one at a time from a queue persisted per user in AsyncStorage
  (`ops.uploads.pending.<userId>`). Up to 3 automatic retries (2, 4, 8 s with jitter, from
  `uploadRetryDelayMs` in `@ops/shared`), then a manual Retry; a refusal waits for the worker. A
  checkpoint per photo makes a retry renew the same pending attachment and skip the PUT when only
  `complete` failed.
- **Photos** (`src/device/photos.ts`, `photoSizing.ts`, `files.ts`, `upload.ts`): camera or
  gallery (`expo-image-picker`), resized to 1600 px on the long edge and re-encoded as JPEG at
  0.7 (`expo-image-manipulator`; HEIC becomes JPEG, metadata dropped), copied to
  `Paths.document/pending-photos/` until the upload completes, PUT with `expo-file-system`'s
  native upload and progress, or `fetch` with a blob as a fallback (no progress).
- **Location** (`src/device/location.ts`, `locationLogic.ts`): foreground permission, asked once;
  a last-known fix under 2 minutes old, else a fresh high-accuracy fix within 10 s; saved with its
  accuracy; never blocks saving.
- **Drafts and retention** (`src/storage/`): the new-log form is drafted per user
  (`ops.drafts.newWorkLog.<userId>`); edit forms are not drafted. At every app start drafts and
  queued photos older than 14 days are deleted for every user of the phone (`retention.ts`).
- **i18n** (`src/i18n/`): every sentence comes from the typed catalogue `en.ts` through `t(key)`;
  `authText.ts`, `errorText.ts`, and `roles.ts` map shared codes to keys. The language is picked
  from the phone (`expo-localization`) with English as fallback. RTL: styles use `start` / `end`,
  `applyLayoutDirection()` at start-up, `extra.supportsRTL` in `app.config.ts`.
- **Push** (`src/push/`): `pushSupport.ts` decides availability (no push in Expo Go on Android,
  on simulators, or without an EAS project id); `pushService.ts` registers after sign-in and on
  every cold start with a live session, again when the app returns to the foreground after 24
  hours, and unregisters (3 s timeout) before sign-out; `usePush.tsx` wires it to the app state
  and to taps, which open the task or log (`logic/notificationRouting.ts` accepts UUIDs only).
- **Session**: unchanged from Phase 3 (`createAuthSessionManager({ mode: 'mobile' })`, tokens in
  `expo-secure-store`, bearer header). When the server cannot be reached at start, the app shows
  the sign-in screen with an "unreachable" notice and keeps the stored tokens (Phase 5 changes
  this).
- **Development build**: `expo-dev-client` installed; `eas.json` profile `development`
  (development client, internal distribution, Android APK, no iOS simulator build). Never built.
- **Tests**: 154 unit tests in 15 suites (confirmed 2026-10-17).

Verified in the Phase 4 session: lint, typecheck, and tests pass; the repositories ran end to end
against the real API outside a phone (a log with custom fields, a duplicate `clientId`, a photo
upload, a rejection and its notification); `expo export` succeeds; `expo-doctor` 21/21.

## Key files

| File                       | What it does                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | Entry point (`main` in `package.json`). Registers `App`.                                                                                                                                                                     |
| `App.tsx`                  | Layout direction, the 14-day retention sweep, providers (`SafeAreaProvider`, `AuthProvider`, `DataProvider`, `PushProvider`), the navigator by sign-in state, the navigation theme from the tokens.                          |
| `app.config.ts`            | Expo config: name, identifiers, EAS project id, plugins and iOS permission texts (see below).                                                                                                                                |
| `eas.json`                 | EAS Build profile `development`.                                                                                                                                                                                             |
| `src/data/repositories.ts` | The one write path (interfaces for Phase 5 and the remote implementation).                                                                                                                                                   |
| `src/data/queries.ts`      | All reads (TanStack Query hooks).                                                                                                                                                                                            |
| `src/data/uploadQueue.ts`  | The persisted photo upload queue and its error kinds.                                                                                                                                                                        |
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

| Setting                                   | Value                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                    | `EXPO_PUBLIC_BRAND_NAME`, or "Operations" when unset                                                                                                                                                                    |
| `slug` / `scheme`                         | `operations-app` / `operationsapp` (not used for deep links yet)                                                                                                                                                        |
| iOS `bundleIdentifier`, Android `package` | `EXPO_IOS_BUNDLE_IDENTIFIER` / `EXPO_ANDROID_PACKAGE`, default `ai.kaneri.operations`                                                                                                                                   |
| `extra`                                   | `supportsRTL: true`; `eas.projectId` from `EXPO_PUBLIC_EAS_PROJECT_ID` when set                                                                                                                                         |
| Plugins                                   | `expo-splash-screen`, `expo-system-ui`, `expo-secure-store`, `expo-image-picker` (camera and photos texts, no microphone), `expo-location` (when in use only, no background), `expo-notifications`, `expo-localization` |
| `userInterfaceStyle`, background          | `dark`, the `background` token                                                                                                                                                                                          |

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

- **Every write through `src/data/repositories.ts`.** Screens and hooks never call `apiClient` to
  change data; reads go through `src/data/queries.ts`.
- **Every user-facing string through `src/i18n`** (`t('...')`); no English in screens. Styles use
  `start` / `end`, never `left` / `right`.
- **Tokens only in SecureStore**; drafts and the upload queue in AsyncStorage through
  `KeyValueStore`; nothing local older than 14 days.
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
- Keep `expo` (~57.0.30), `react-native` (0.86.3), `react` (exactly 19.2.3), and every `expo-*`
  package on the versions Expo SDK 57 expects (`npx expo install --check`).

## Known issues

- **Not run on a phone.** Accessibility (screen reader, dynamic type), sunlight readability, and
  glove use are unchecked.
- **Android Expo Go has no remote push** (since SDK 53); push needs the development build, which
  has never been built. iOS Expo Go can receive push with an EAS project id.
- Online only: no local queue for logs (Phase 5); the edit form keeps no draft; no signed-in state
  when the server is unreachable at start.
- No activation deep links: activation links open the web page.
- An Arabic (RTL) catalogue switches the layout only after the next app start.
- The bundle identifiers are placeholders until the owner decides.
- No `metro.config.js` or `babel.config.js`; Expo's defaults handle the pnpm layout.
- The ESLint config sets `settings.react.version` to `'19.2'` by hand. Bump it when React changes.
- Changing an `EXPO_PUBLIC_*` value needs a dev server restart with `--clear`.
- `expo start --tunnel` does not work (no `@expo/ngrok`).
- No component or screen tests; the logic modules are tested.
