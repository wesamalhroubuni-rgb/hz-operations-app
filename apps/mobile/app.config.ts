import { defaultTheme } from '@ops/shared';
import type { ExpoConfig } from 'expo/config';

/**
 * Expo configuration. It is a TypeScript file rather than `app.json` so the app name can come
 * from EXPO_PUBLIC_BRAND_NAME (root `.env`, loaded by dotenv-cli in the package scripts).
 *
 * Re-branding for another client changes only that variable and the files in `assets/brand/`.
 * The slug, scheme and default bundle identifiers are neutral on purpose: do not put a client's
 * name in them. `@ops/shared` must be built before any Expo command, as for the app itself (on
 * EAS Build the `eas-build-post-install` script does it).
 *
 * Expo Go shows its own icon and splash screen and ignores the config plugins below; they apply
 * to development builds and release builds.
 */
// Expo's config loader cannot import other TypeScript files of the app, so the fallback name is
// repeated here. Keep it equal to DEFAULT_BRAND_NAME in `src/config/env.ts`.
const DEFAULT_BRAND_NAME = 'Operations';
const brandName = process.env.EXPO_PUBLIC_BRAND_NAME?.trim() || DEFAULT_BRAND_NAME;
const backgroundColor = defaultTheme.colors.background;

// The store identifiers. The defaults are placeholders until the owner decides the final ones
// (they cannot change after a store release). Set them before the first store build.
const iosBundleIdentifier =
  process.env.EXPO_IOS_BUNDLE_IDENTIFIER?.trim() || 'ai.kaneri.operations';
const androidPackage = process.env.EXPO_ANDROID_PACKAGE?.trim() || 'ai.kaneri.operations';

// The EAS project id (`eas init` prints it). Needed for Expo push tokens and for EAS Build. When it
// is not set the app runs without push; the in-app notification list works anyway.
const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || undefined;

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
    bundleIdentifier: iosBundleIdentifier,
  },
  android: {
    package: androidPackage,
    predictiveBackGestureEnabled: false,
    adaptiveIcon: {
      // The logo at 80% on a black canvas, so launcher masks do not crop the ring.
      foregroundImage: './assets/brand/adaptive-icon-foreground.png',
      backgroundColor,
    },
  },
  extra: {
    // Lets React Native lay out right to left for Arabic (see `src/i18n/index.ts`).
    supportsRTL: true,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
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
    // permission text is not added.
    ['expo-secure-store', { faceIDPermission: false, configureAndroidBackup: true }],
    // Permission texts shown by iOS. Only what the app uses: camera and photos for work log
    // photos, location while the app is open. No background location, no microphone.
    [
      'expo-image-picker',
      {
        photosPermission: 'Photos you choose are attached to your work logs.',
        cameraPermission: 'Photos you take are attached to your work logs.',
        microphonePermission: false,
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission: 'Your location is saved with the work logs you create.',
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    [
      'expo-notifications',
      {
        color: defaultTheme.colors.primary,
      },
    ],
    'expo-localization',
  ],
};

export default config;
