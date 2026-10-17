import { createNavigationContainerRef } from '@react-navigation/native';

import type { NotificationTarget } from '../logic/notificationRouting';
import type { SignedInStackParamList } from './types';

/** Lets code outside the screens (a tapped push notification) navigate. */
export const navigationRef = createNavigationContainerRef<SignedInStackParamList>();

let pending: NotificationTarget | null = null;

function navigate(target: NotificationTarget): void {
  if (target.screen === 'TaskDetail') navigationRef.navigate('TaskDetail', target.params);
  else navigationRef.navigate('LogDetail', target.params);
}

/**
 * Opens a task or a log. When the signed-in navigator is not ready yet (the tap launched the
 * app), the target waits until `flushPendingTarget` runs.
 */
export function openTarget(target: NotificationTarget): void {
  const routeNames = navigationRef.isReady()
    ? (navigationRef.getRootState()?.routeNames ?? [])
    : [];
  if (routeNames.includes(target.screen)) {
    navigate(target);
  } else {
    pending = target;
  }
}

/** Called when the signed-in navigator becomes ready. */
export function flushPendingTarget(): void {
  if (pending === null || !navigationRef.isReady()) return;
  const routeNames = navigationRef.getRootState()?.routeNames ?? [];
  if (!routeNames.includes(pending.screen)) return;
  const target = pending;
  pending = null;
  navigate(target);
}
