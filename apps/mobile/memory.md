# apps/mobile memory

Package `@ops/mobile`. Last updated: 2026-10-13.

## Purpose

The worker app for iOS and Android, from one React Native codebase with Expo. Workers will use it
to log work with text, photos, and location (voice later), including without a network.

## Current state

A branded placeholder. One screen, `HomeScreen`, with the client's logo, the product name, the
label "Worker app", an "API status" card, and a small "Powered by Kaneri.ai" line.

- **Branding comes from configuration.** The name is `EXPO_PUBLIC_BRAND_NAME` (fallback
  "Operations"). Screens read it from `src/config/brand.ts`. `app.config.ts` uses the same variable
  for the app name on the device.
- **Colours and sizes come from the design tokens in `@ops/shared`**, imported directly into
  `StyleSheet.create`. The theme is dark only; the status bar uses light icons.
- **Icon, adaptive icon, and splash screen are configured** in `app.config.ts` from
  `assets/brand/`. Expo Go shows its own icon and splash, so they have not been seen yet.
- **The status card uses the shared API client and health monitor.** It calls `GET /health`, and
  while nothing answers it retries after 2, 4, 8, and 16 seconds, then waits for "Check again".
  States and wording come from `describeHealth` in `@ops/shared`, the same as on the web.
- It calls no endpoint other than `/health` and does not send the dev header. Runs in Expo Go.
  There is no native project (`android/`, `ios/`), no navigation library, no local storage, no
  sign-in.
- 8 unit tests in 1 file (`src/config/env.test.ts`).

Verified on 2026-10-13: lint, typecheck, and tests pass; `expo export` succeeds for Android and
iOS; `expo-doctor` 21/21. **Never verified on a real phone**, in Expo Go or in a build. That is
deferred to Phase 4 because the campus Wi-Fi blocks phone-to-PC traffic.

## Key files

| File                                        | What it does                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                  | Entry point (`main` in `package.json`). Registers `App`.                                                                                                                                                      |
| `App.tsx`                                   | Wraps `HomeScreen` in `SafeAreaProvider`; light status bar.                                                                                                                                                   |
| `app.config.ts`                             | Expo config in TypeScript (replaces `app.json`). Name from `EXPO_PUBLIC_BRAND_NAME`, colours from the tokens, icon, adaptive icon, and the plugins `expo-splash-screen`, `expo-status-bar`, `expo-system-ui`. |
| `assets/brand/logo-512.png`                 | Logo shown on the screen and on the splash screen.                                                                                                                                                            |
| `assets/brand/icon-1024.png`                | App icon.                                                                                                                                                                                                     |
| `assets/brand/adaptive-icon-foreground.png` | Android adaptive icon foreground: the logo at 80% so launcher masks do not crop it.                                                                                                                           |
| `src/config/env.ts`                         | The only place the bundle reads environment variables. `env.apiUrl` (or `null`), `env.brandName`.                                                                                                             |
| `src/config/brand.ts`                       | `brand`: name, app label, logo, and the "Powered by Kaneri.ai" line.                                                                                                                                          |
| `src/api/client.ts`                         | `apiClient`: the app's one typed API client (`null` without an API URL).                                                                                                                                      |
| `src/hooks/useApiHealth.ts`                 | Connects the shared health monitor to React with `useSyncExternalStore`.                                                                                                                                      |
| `src/screens/HomeScreen.tsx`                | The placeholder screen.                                                                                                                                                                                       |
| `src/types/assets.d.ts`                     | Lets TypeScript import `*.png` as an image source.                                                                                                                                                            |
| `eslint.config.mjs`                         | `eslint-config-expo` plus the shared base, with the React version stated by hand.                                                                                                                             |
| `jest.config.js`                            | `jest-expo` preset; tests are `src/**/*.test.ts(x)`.                                                                                                                                                          |
| `tsconfig.json`                             | Extends `expo/tsconfig.base` and the shared `@ops/config/tsconfig/strict.json`.                                                                                                                               |

`app.json`, `src/api/health.ts`, and its test from Phase 1 were deleted.

## Expo configuration

| Setting                                      | Value                                                |
| -------------------------------------------- | ---------------------------------------------------- |
| `name`                                       | `EXPO_PUBLIC_BRAND_NAME`, or "Operations" when unset |
| `slug`                                       | `operations-app`                                     |
| `scheme`                                     | `operationsapp`                                      |
| iOS `bundleIdentifier`, Android `package`    | `ai.kaneri.operations` (hard-coded)                  |
| `userInterfaceStyle`                         | `dark`                                               |
| Background, splash, adaptive icon background | the `background` token (`#000000`)                   |

The slug, scheme, and identifiers are neutral on purpose: no client name. The identifiers must
come from configuration and be decided before the first store or development build (Phase 4).

## Environment variables

| Variable                 | Notes                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `EXPO_PUBLIC_API_URL`    | Base URL of the API. Inlined into the bundle. On a phone it must be the PC's Wi-Fi address, not `localhost`. |
| `EXPO_PUBLIC_BRAND_NAME` | Product name. Inlined into the bundle, and read by `app.config.ts` for the app name.                         |

If the API URL is empty, the app does not crash; the card shows "API not configured".

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

## Re-branding for another client

1. Set `EXPO_PUBLIC_BRAND_NAME`.
2. Replace the three files in `assets/brand/` (same names, same sizes).
3. If the colours change, edit the tokens in `packages/shared/src/theme/tokens.ts`.
4. Restart the dev server (`--clear` for an export).

## Conventions

- `src/screens/` is presentation, `src/hooks/` is state, `src/api/` is the API client,
  `src/config/` is environment and brand.
- **Never write a client name in a screen.** Read `brand` from `src/config/brand.ts`. The only
  mention of Kaneri.ai is `brand.poweredBy`.
- **Never write a colour, spacing, radius, or font size literal in a style.** Import `colors`,
  `spacing`, `radii`, `fontSizes`, `fontWeights` from `@ops/shared`. The brand red
  (`colors.accent`) is for decoration, not text.
- **Every call to the API goes through `apiClient`.** Calls return an `ApiResult` and never throw.
  Logic shared with the web belongs in `@ops/shared`, not here.
- Read environment variables only in `src/config/env.ts`, with static dot notation
  (`process.env.EXPO_PUBLIC_API_URL`). Destructuring or `process.env[name]` is not replaced by the
  bundler.
- `DEFAULT_BRAND_NAME` exists twice, in `src/config/env.ts` and in `app.config.ts`, because Expo's
  config loader cannot import the app's TypeScript files. Change both together.
- `@ops/shared` must be built before any Expo command, because `app.config.ts` imports it.
- Relative imports only; no path alias is configured.
- Tests are `*.test.ts` or `*.test.tsx` next to the code, run with Jest 29 and the `jest-expo`
  preset.
- Keep `expo`, `react-native`, `react`, and the `expo-*` packages on the versions Expo SDK 57
  expects. `react` is pinned to exactly `19.2.3` and must match `apps/web`.

## Known issues

- **A phone cannot reach the API in the default configuration.** `API_HOST` is `127.0.0.1` and
  `EXPO_PUBLIC_API_URL` is `http://localhost:3001`. A phone test needs `API_HOST=0.0.0.0` on a
  trusted network and the PC's Wi-Fi address in `EXPO_PUBLIC_API_URL`.
- Expo Go shows its own icon and splash screen. The configured ones need a development or release
  build, and there is no build setup yet.
- When the API needs the dev header or a token, pass `getHeaders` to `createApiClient` in
  `src/api/client.ts`. Nothing sets it today.
- No `metro.config.js` or `babel.config.js`. Expo's defaults handle the pnpm isolated layout. Add
  one only when a concrete need appears.
- The ESLint config sets `settings.react.version` to `'19.2'` because eslint-plugin-react's
  `detect` mode crashes on ESLint 10. Bump it when React changes.
- `tsconfig.json` extends `expo/tsconfig.base` and `@ops/config/tsconfig/strict.json` (the shared
  strictness flags). It does not extend the shared `base.json`, which would override Expo's
  `lib` and `target`.
- Changing an `EXPO_PUBLIC_*` value needs a dev server restart, and `expo export` needs `--clear`,
  or the old value stays in the bundle.
- `expo start --tunnel` does not work; it needs `@expo/ngrok`, which is not installed. The phone and
  the PC must be on the same Wi-Fi network.
- There are no component or screen tests; only `src/config/env.ts` is tested.
