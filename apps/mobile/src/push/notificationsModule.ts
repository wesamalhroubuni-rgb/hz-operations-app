import { isRunningInExpoGo } from 'expo';
import type * as ExpoNotifications from 'expo-notifications';
import { Platform } from 'react-native';

type NotificationsModule = typeof ExpoNotifications;

/**
 * `expo-notifications`, or null where it cannot be loaded. Expo Go for Android (SDK 57, client
 * 57.0.9) lacks the native `ExpoTopicSubscriptionModule` that `expo-notifications` 57.0.24 requires
 * at import time, so importing it there crashes the app at start (seen on a real phone,
 * 2026-11-16). Remote push is unavailable in Android Expo Go anyway (`pushSupport.ts`), and the
 * in-app notification list does not use this module, so the app runs without it there. Every
 * other build (development build, store build, iOS Expo Go) loads it as before.
 */
function load(): NotificationsModule | null {
  if (Platform.OS === 'android' && isRunningInExpoGo()) return null;
  // A require (not an import) so the module is never evaluated where it would crash.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications') as NotificationsModule;
}

export const Notifications: NotificationsModule | null = load();
