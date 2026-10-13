# apps/mobile memory

Package `@ops/mobile`. Last updated: 2026-10-12.

## Purpose

The worker app for iOS and Android, from one React Native codebase with Expo. Workers will use it
to log work with text, photos, and location (voice later), including without a network.

## Current state

Phase 1 placeholder. One screen, `HomeScreen`, with a title and an "API status" card.

- On mount it calls `GET {EXPO_PUBLIC_API_URL}/health`, validates the body with
  `healthResponseSchema` from `@ops/shared`, and shows one of: API not configured, checking, API
  reachable (database up or down), API unreachable (with a reason). A Retry button repeats the
  call.
- Runs in Expo Go. There is no native project (`android/`, `ios/`), no navigation library, no
  local storage, no sign-in.
- 5 unit tests, all in `src/api/health.test.ts`.

Verified on 2026-10-12: Metro dev server running (`/status`), `expo export` for Android and iOS,
`expo-doctor` 21/21. **Not yet verified**: the app on a real phone in Expo Go.

## Key files

| File                         | What it does                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `index.ts`                   | Entry point (`main` in `package.json`). Registers `App`.                                          |
| `App.tsx`                    | Wraps `HomeScreen` in `SafeAreaProvider`.                                                         |
| `app.json`                   | Expo config: name, slug, scheme `operationsapp`, bundle and package id `ai.kaneri.operations`.    |
| `src/config/env.ts`          | The only place that reads environment variables. Trims the URL and strips trailing slashes.       |
| `src/api/health.ts`          | `fetchHealth(apiUrl, { timeoutMs })`. Never throws; returns a typed result with a failure reason. |
| `src/hooks/useApiHealth.ts`  | Runs the check on mount and on retry; ignores stale answers.                                      |
| `src/screens/HomeScreen.tsx` | The placeholder screen.                                                                           |
| `eslint.config.mjs`          | `eslint-config-expo` plus the shared base, with the React version stated by hand.                 |
| `jest.config.js`             | `jest-expo` preset; tests are `src/**/*.test.ts(x)`.                                              |
| `tsconfig.json`              | Extends `expo/tsconfig.base` and the shared `@ops/config/tsconfig/strict.json`.                   |

## Environment variables

| Variable              | Notes                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `EXPO_PUBLIC_API_URL` | Base URL of the API. Inlined into the bundle. On a phone it must be the PC's Wi-Fi address, not `localhost`. |

If it is empty, the app does not crash; the card shows "API not configured".

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

- `src/screens/` is presentation, `src/hooks/` is state, `src/api/` is HTTP with no React in it,
  `src/config/` is environment.
- Read environment variables only in `src/config/env.ts`, with static dot notation
  (`process.env.EXPO_PUBLIC_API_URL`). Destructuring or `process.env[name]` is not replaced by the
  bundler.
- Functions that call the API return a typed result union and do not throw. Parse the response body
  with a schema from `@ops/shared` whatever the HTTP status is.
- Relative imports only; no path alias is configured.
- Tests are `*.test.ts` or `*.test.tsx` next to the code, run with Jest 29 and the `jest-expo`
  preset, and replace `globalThis.fetch` with a mock.
- Keep `expo`, `react-native`, and `react` on the versions Expo SDK 57 expects. `react` is pinned to
  exactly `19.2.3` and must match `apps/web`.

## Known issues

- No `metro.config.js` or `babel.config.js`. Expo's defaults handle the pnpm isolated layout. Add
  one only when a concrete need appears.
- The ESLint config sets `settings.react.version` to `'19.2'` because eslint-plugin-react's
  `detect` mode crashes on ESLint 10. Bump it when React changes.
- `tsconfig.json` extends `expo/tsconfig.base` and `@ops/config/tsconfig/strict.json` (the shared
  strictness flags). It does not extend the shared `base.json`, which would override Expo's
  `lib` and `target`.
- Changing an `EXPO_PUBLIC_*` value needs a dev server restart, and `expo export` needs `--clear`,
  or the old value stays in the bundle.
- No icon or splash assets yet. Expo shows its defaults.
- `expo start --tunnel` does not work; it needs `@expo/ngrok`, which is not installed. The phone and
  the PC must be on the same Wi-Fi network.
- `app.json` is static, so it cannot read environment variables. Convert it to `app.config.ts` if
  build-time configuration is needed.
- There are no component or screen tests; only `src/api` logic is tested.
