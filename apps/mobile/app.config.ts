import { defaultTheme } from '@ops/shared';
import type { ExpoConfig } from 'expo/config';

/**
 * Expo configuration. It is a TypeScript file rather than `app.json` so the app name can come
 * from EXPO_PUBLIC_BRAND_NAME (root `.env`, loaded by dotenv-cli in the package scripts).
 *
 * Re-branding for another client changes only that variable and the files in `assets/brand/`.
 * The slug, scheme and bundle identifiers are neutral on purpose: do not put a client's name in
 * them. `@ops/shared` must be built before any Expo command, as for the app itself.
 *
 * Expo Go shows its own icon and splash screen; the ones configured here appear in development
 * builds and release builds.
 */
// Expo's config loader cannot import other TypeScript files of the app, so the fallback name is
// repeated here. Keep it equal to DEFAULT_BRAND_NAME in `src/config/env.ts`.
const DEFAULT_BRAND_NAME = 'Operations';
const brandName = process.env.EXPO_PUBLIC_BRAND_NAME?.trim() || DEFAULT_BRAND_NAME;
const backgroundColor = defaultTheme.colors.background;

const config: ExpoConfig = {
  name: brandName,
  slug: 'operations-app',
  version: '0.1.0',
  scheme: 'operationsapp',
  platforms: ['ios', 'android'],
  orientation: 'portrait',
  // Dark only, like the brand. expo-system-ui applies this and the background on Android.
  userInterfaceStyle: defaultTheme.scheme,
  backgroundColor,
  icon: './assets/brand/icon-1024.png',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'ai.kaneri.operations',
  },
  android: {
    package: 'ai.kaneri.operations',
    predictiveBackGestureEnabled: false,
    adaptiveIcon: {
      // The logo at 80% on a black canvas, so launcher masks do not crop the ring.
      foregroundImage: './assets/brand/adaptive-icon-foreground.png',
      backgroundColor,
    },
  },
  plugins: [
    [
      'expo-splash-screen',
      {
        image: './assets/brand/logo-512.png',
        imageWidth: 220,
        resizeMode: 'contain',
        backgroundColor,
      },
    ],
    ['expo-status-bar', { style: 'light' }],
    'expo-system-ui',
    // Session tokens are kept in SecureStore. The plugin keeps them out of Android's automatic
    // backup (a restored copy could not be decrypted anyway); Face ID is not used, so its
    // permission text is not added. Takes effect in development and release builds, not Expo Go.
    ['expo-secure-store', { faceIDPermission: false, configureAndroidBackup: true }],
  ],
};

export default config;
