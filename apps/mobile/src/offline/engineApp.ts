import type { ApiClient } from '@ops/shared';
import { AppState } from 'react-native';

import { putFileFromUri } from '../device/upload';
import { createSyncEngine, type AppSyncEngine, type ForegroundSource } from './engine';
import { deviceStore } from '../storage/deviceStore';
import { createDroppedReferenceNotices, type DroppedReferenceNotices } from './engineNotices';
import { createRetryPolicy } from './engineRetry';
import { appNetworkMonitor } from './network';
import type { LocalPhotoStore, LocalStore, SyncEngineDeps, WriteQueue } from './types';

// The engine as the app runs it: photo bytes are PUT with expo-file-system, "foreground" is
// React Native's AppState, connectivity is NetInfo, the clock is the phone's.

const noticesPerUser = new Map<string, DroppedReferenceNotices>();

/** The app's dropped-link notices of one user (AsyncStorage). */
export function droppedReferenceNoticesFor(userId: string): DroppedReferenceNotices {
  let notices = noticesPerUser.get(userId);
  if (!notices) {
    notices = createDroppedReferenceNotices(deviceStore, userId);
    noticesPerUser.set(userId, notices);
  }
  return notices;
}

export const appForeground: ForegroundSource = {
  isActive: () => AppState.currentState === 'active',
  subscribe(listener) {
    let last = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const wasActive = last === 'active';
      last = next;
      if ((next === 'active') !== wasActive) listener(next === 'active');
    });
    return () => subscription.remove();
  },
};

/** Builds the engine from complete deps (tests and custom wiring). */
export function createAppSyncEngine(deps: SyncEngineDeps): AppSyncEngine {
  return createSyncEngine(deps, {
    put: (photo) => putFileFromUri(photo.uri),
    foreground: appForeground,
    onDroppedReferences: (log, fields) =>
      droppedReferenceNoticesFor(deps.userId).record(log.clientId, fields, new Date()),
    log: __DEV__
      ? // Diagnostics in development only; the details never hold a token, URL or body.
        (event, details) => console.info(`[sync] ${event}`, details ?? '')
      : undefined,
  });
}

/**
 * What the offline session factory calls when it opens a user's offline layer: the user's own
 * store, queue and photo store, the session's API client, and what to do when the session cannot
 * be renewed. Network, clock and retry policy are the app's.
 */
export function createUserSyncEngine(input: {
  userId: string;
  store: LocalStore;
  queue: WriteQueue;
  photos: LocalPhotoStore;
  api: ApiClient;
  onNeedsSignIn: () => void;
}): AppSyncEngine {
  return createAppSyncEngine({
    ...input,
    network: appNetworkMonitor(),
    clock: () => new Date(),
    retry: createRetryPolicy(),
  });
}
