import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { useRepositories } from '../data/DataProvider';
import { queryKeys } from '../data/queryKeys';
import { notificationTarget } from '../logic/notificationRouting';
import { openTarget } from '../navigation/navigationRef';
import { configureForegroundPresentation, pushDevice } from './pushDevice';
import { createPushService, type PushService, type PushState } from './pushService';

const PushContext = createContext<PushService | null>(null);

configureForegroundPresentation();

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Push notifications for the signed-in user: registers this phone after sign-in, refreshes the
 * in-app list when a notification arrives while the app is open, and opens the task or log when
 * one is tapped (also when the tap started the app).
 */
export function PushProvider({ children }: Readonly<{ children: ReactNode }>) {
  const repositories = useRepositories();
  const queryClient = useQueryClient();
  const service = useMemo(
    () => createPushService(pushDevice, repositories.notifications),
    [repositories],
  );

  useEffect(() => {
    // Every cold start with a live session mounts this provider: register the token again.
    void service.register();
    // And when the app returns to the foreground more than a day after the last attempt.
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') void service.refreshIfStale();
    });
    return () => subscription.remove();
  }, [service]);

  useEffect(() => {
    function handleTap(response: Notifications.NotificationResponse): void {
      const content = response.notification.request.content;
      const data = (content.data ?? {}) as Record<string, unknown>;
      if (typeof data.notificationId === 'string' && UUID.test(data.notificationId)) {
        void repositories.notifications.markRead(data.notificationId);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      const target = notificationTarget(data, typeof data.type === 'string' ? data.type : null);
      if (target) openTarget(target);
    }

    const received = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    });
    const tapped = Notifications.addNotificationResponseReceivedListener(handleTap);
    // A tap that launched the app arrived before this listener existed.
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      handleTap(last);
      Notifications.clearLastNotificationResponse();
    }
    return () => {
      received.remove();
      tapped.remove();
    };
  }, [queryClient, repositories]);

  return <PushContext.Provider value={service}>{children}</PushContext.Provider>;
}

export function usePushService(): PushService | null {
  return useContext(PushContext);
}

const IDLE: PushState = { status: 'idle' };
const noop = () => () => undefined;

export function usePushState(): PushState {
  const service = usePushService();
  return useSyncExternalStore(service?.subscribe ?? noop, () => service?.getState() ?? IDLE);
}
