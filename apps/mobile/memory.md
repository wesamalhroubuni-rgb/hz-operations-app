# apps/mobile memory

Package `@ops/mobile`. Last updated: 2026-10-16.

## Purpose

The worker app for iOS and Android, from one React Native codebase with Expo. Workers will use it
to log work with text, photos, and location (voice later), including without a network.

## Current state

Sign-in only (Phase 3, code complete on 2026-10-16). No work-logging screens yet (Phase 4).

- **Screens**: `LoginScreen` (email, phone, or username plus password; "I have an activation
  code"), `ActivateScreen` (code, new password, confirmation), `HomeScreen` (placeholder: name,
  role label, organization, "Sign out", "Sign out everywhere", API status card), `LoadingScreen`.
  `App.tsx` picks the screen from the sign-in state with `screenFor` (`src/navigation/screen.ts`);
  there is no navigation library.
- **Session**: `createAuthSessionManager({ mode: 'mobile' })` from `@ops/shared`. A `mobile` sign-in
  returns tokens in the body; they are kept in memory and in `expo-secure-store`
  (`src/auth/token-storage.ts`, one entry `ops.auth.tokens`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`) and
  sent as `Authorization: Bearer`. A rotated pair is saved before it is used. No cookies
  (`credentials: 'omit'`). The device name sent at sign-in is a constant per platform.
- Sends `EXPO_PUBLIC_ORGANIZATION_SLUG` with every sign-in.
- The `expo-secure-store` config plugin (no Face ID text, Android backup configured) is in
  `app.config.ts`; it applies to development and release builds, not Expo Go.
- **Branding** as in Phase 2 (`EXPO_PUBLIC_BRAND_NAME`, `src/config/brand.ts`, tokens from
  `@ops/shared`, icon and splash in `app.config.ts`).
- Activation links point at the web app's `/activate`; deep links into the app are Phase 4. When
  the server cannot be reached at start, the app shows the sign-in screen with an "unreachable"
  notice and keeps the stored tokens; a proper offline signed-in state is Phase 4.
- 20 unit tests in 3 files (`src/config/env.test.ts`, `src/auth/token-storage.test.ts`,
  `src/navigation/screen.test.ts`).

Verified in the Phase 3 session: lint, typecheck, and tests pass; the shared session manager was
run in mobile mode against the real API; `expo export` succeeds and `expo-doctor` passes. **Never
run on a real phone** (Expo Go or a build), so the screens and SecureStore have not been seen on a
device. Deferred to Phase 4: the campus Wi-Fi blocks phone-to-PC traffic.

## Key files

| File                        | What it does                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                  | Entry point (`main` in `package.json`). Registers `App`.                                                                                                                          |
| `App.tsx`                   | `SafeAreaProvider`, `AuthProvider`, and the screen switch; light status bar.                                                                                                      |
| `app.config.ts`             | Expo config: name from `EXPO_PUBLIC_BRAND_NAME`, colours from the tokens, icon, splash, plugins (`expo-splash-screen`, `expo-status-bar`, `expo-system-ui`, `expo-secure-store`). |
| `src/auth/AuthProvider.tsx` | Subscribes to the session manager, starts the session check, `useAuth()`.                                                                                                         |
| `src/auth/token-storage.ts` | `createSecureTokenStorage()`: the `TokenStorage` on SecureStore; discards unreadable entries.                                                                                     |
| `src/api/client.ts`         | `authSession` (mobile-mode session manager with SecureStore) and `apiClient`, both `null` without an API URL; `DEVICE_NAME`.                                                      |
| `src/navigation/screen.ts`  | `screenFor(status, chosen)`: the whole navigation map of this phase.                                                                                                              |
| `src/screens/`              | `LoginScreen`, `ActivateScreen`, `HomeScreen`, `LoadingScreen`.                                                                                                                   |
| `src/components/`           | `AuthScreenLayout`, `BrandHeader`, `Button`, `FormField`, `Message`, `ApiStatusCard`.                                                                                             |
| `src/hooks/`                | `useLoginForm`, `useActivateForm`, `useSignOut`, `useApiHealth`.                                                                                                                  |
| `src/config/env.ts`         | The only place the bundle reads environment variables: `apiUrl`, `brandName`, `organizationSlug`.                                                                                 |
| `src/config/brand.ts`       | `brand`: name, app label, logo, and the "Powered by Kaneri.ai" line.                                                                                                              |
| `assets/brand/`             | `logo-512.png`, `icon-1024.png`, `adaptive-icon-foreground.png`.                                                                                                                  |
| `eslint.config.mjs`         | `eslint-config-expo` plus the shared base, with the React version stated by hand.                                                                                                 |
| `jest.config.js`            | `jest-expo` preset; tests are `src/**/*.test.ts(x)`.                                                                                                                              |
| `tsconfig.json`             | Extends `expo/tsconfig.base` and the shared `@ops/config/tsconfig/strict.json`.                                                                                                   |

## Expo configuration

| Setting                                      | Value                                                |
| -------------------------------------------- | ---------------------------------------------------- |
| `name`                                       | `EXPO_PUBLIC_BRAND_NAME`, or "Operations" when unset |
| `slug`                                       | `operations-app`                                     |
| `scheme`                                     | `operationsapp` (not used for deep links yet)        |
| iOS `bundleIdentifier`, Android `package`    | `ai.kaneri.operations` (hard-coded)                  |
| `userInterfaceStyle`                         | `dark`                                               |
| Background, splash, adaptive icon background | the `background` token (`#000000`)                   |

The identifiers must come from configuration and be decided before the first store or development
build (Phase 4).

## Environment variables

| Variable                        | Notes                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `EXPO_PUBLIC_API_URL`           | Base URL of the API. Inlined into the bundle. On a phone it must be the PC's Wi-Fi address, not `localhost`. |
| `EXPO_PUBLIC_BRAND_NAME`        | Product name. Inlined into the bundle, and read by `app.config.ts` for the app name.                         |
| `EXPO_PUBLIC_ORGANIZATION_SLUG` | Sent with every sign-in (`hz-demo`).                                                                         |

If the API URL is empty, the app does not crash; sign-in reports the configuration problem and the
status card shows "API not configured".

## Scripts

Run from the repo root as `pnpm --filter @ops/mobile <script>`.

| Script      | Command                                     |
| ----------- | ------------------------------------------- |
| `dev`       | `expo start` with the root `.env`           |
| `android`   | `expo start --android` with the root `.env` |
| `ios`       | `expo start --ios` with the root `.env`     |
| `lint`      | `eslint .`                                  |
| `typecheck` | `tsc --noEmit`                              |
| `test`      | `jest`                                      |

There is no `build` script by design. Turbo skips this package for `pnpm build`.

## Conventions

- `src/screens/` is presentation, `src/components/` reusable UI, `src/hooks/` state, `src/auth/`
  the session provider and token storage, `src/api/` the session and client, `src/config/`
  environment and brand, `src/navigation/` the screen choice.
- **Every call to the API goes through `apiClient` / `authSession`.** Sign-in logic, wording
  (`AUTH_TEXT`, `roleLabel`), and form validation live in `@ops/shared`.
- **Tokens only in SecureStore**, never in AsyncStorage, logs, or messages.
- **Never write a client name in a screen.** Read `brand` from `src/config/brand.ts`.
- **Never write a colour, spacing, radius, or font size literal in a style.** Import the tokens.
- Read environment variables only in `src/config/env.ts`, with static dot notation.
- `DEFAULT_BRAND_NAME` exists twice, in `src/config/env.ts` and in `app.config.ts`. Change both.
- `@ops/shared` must be built before any Expo command, because `app.config.ts` imports it.
- Relative imports only; no path alias is configured.
- Keep `expo`, `react-native`, `react`, and the `expo-*` packages on the versions Expo SDK 57
  expects (`expo-secure-store` `~57.0.4`). `react` is pinned to exactly `19.2.3`.

## Known issues

- **A phone cannot reach the API in the default configuration.** A phone test needs
  `API_HOST=0.0.0.0` on a trusted network and the PC's Wi-Fi address in `EXPO_PUBLIC_API_URL`.
- Expo Go shows its own icon and splash screen, and does not apply config plugins; the configured
  ones need a development or release build, and there is no build setup yet.
- No activation deep links and no offline signed-in state yet (Phase 4).
- No `metro.config.js` or `babel.config.js`; Expo's defaults handle the pnpm layout.
- The ESLint config sets `settings.react.version` to `'19.2'` by hand. Bump it when React changes.
- Changing an `EXPO_PUBLIC_*` value needs a dev server restart, and `expo export` needs `--clear`.
- `expo start --tunnel` does not work (no `@expo/ngrok`).
- There are no component or screen tests; only `src/config`, `src/auth/token-storage.ts`, and
  `src/navigation/screen.ts` are tested.
