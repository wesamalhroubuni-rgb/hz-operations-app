import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import type { NetworkMonitor } from './types';

/**
 * Online unless NetInfo says otherwise. "Unknown" (null, the first moments after start, or a
 * reachability check that has not finished) counts as online: the request itself then tells, and
 * a failed request is retried, so guessing online loses nothing; guessing offline would hold the
 * queue back for no reason.
 */
export function isOnlineState(
  state: Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>,
): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

/** The subset of NetInfo used here (injectable for tests). */
export interface NetInfoLike {
  addEventListener(listener: (state: NetInfoState) => void): () => void;
}

/**
 * A `NetworkMonitor` over @react-native-community/netinfo. Listens from creation for the whole
 * life of the signed-in session; `dispose()` stops listening.
 */
export function createNetworkMonitor(
  netInfo: NetInfoLike = NetInfo,
): NetworkMonitor & { dispose(): void } {
  let online = true;
  const listeners = new Set<(online: boolean) => void>();
  const unsubscribe = netInfo.addEventListener((state) => {
    const next = isOnlineState(state);
    if (next === online) return;
    online = next;
    for (const listener of listeners) listener(online);
  });
  return {
    isOnline: () => online,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}

let shared: (NetworkMonitor & { dispose(): void }) | null = null;

/** The app's one network monitor (created on first use, kept for the life of the app). */
export function appNetworkMonitor(): NetworkMonitor {
  shared ??= createNetworkMonitor();
  return shared;
}
