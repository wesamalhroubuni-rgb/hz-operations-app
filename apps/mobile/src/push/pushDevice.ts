import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { env } from '../config/env';
import { t } from '../i18n';
import { Notifications } from './notificationsModule';
import type { PushDevice } from './pushService';
import { pushAvailability, resolveProjectId } from './pushSupport';

export const ANDROID_CHANNEL_ID = 'default';

/** The loaded module; only called after `availability()` said push is available. */
function notifications() {
  if (!Notifications) throw new Error('expo-notifications is not available in this build');
  return Notifications;
}

/** How a notification shows while the app is open: a banner and the list, no sound. */
export function configureForegroundPresentation(): void {
  Notifications?.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return resolveProjectId(env.easProjectId, Constants.easConfig?.projectId, extra?.eas?.projectId);
}

/** The real device side of push registration (expo-notifications, expo-device). */
export const pushDevice: PushDevice = {
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  availability: () =>
    pushAvailability({
      platform: Platform.OS,
      isDevice: Device.isDevice,
      inExpoGo: isRunningInExpoGo(),
      projectId: projectId(),
    }),
  async ensurePermission() {
    const current = await notifications().getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    const asked = await notifications().requestPermissionsAsync();
    return asked.granted;
  },
  async prepare() {
    if (Platform.OS === 'android') {
      await notifications().setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name: t('profile.push.channelName'),
        importance: notifications().AndroidImportance.DEFAULT,
      });
    }
  },
  async getExpoPushToken(id) {
    const token = await notifications().getExpoPushTokenAsync({ projectId: id });
    return token.data;
  },
};
