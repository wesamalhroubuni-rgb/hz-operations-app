import { useMemo, useSyncExternalStore } from 'react';

import { useData } from '../data/DataProvider';
import { isPhotoOfLog, type QueuedPhoto } from '../data/uploadQueue';

/** Every photo still waiting to reach the server, live. */
export function useUploadQueue(): readonly QueuedPhoto[] {
  const { uploads } = useData();
  return useSyncExternalStore(uploads.subscribe, () => uploads.getState()).items;
}

/** The queued photos of one log (by its server id or, before the sync, its clientId). */
export function useLogUploads(workLogId: string): readonly QueuedPhoto[] {
  const items = useUploadQueue();
  return useMemo(() => items.filter((item) => isPhotoOfLog(item, workLogId)), [items, workLogId]);
}

/** How many photos each log still has to upload, under its server id and its clientId. */
export function usePendingPhotoCounts(): ReadonlyMap<string, number> {
  const items = useUploadQueue();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const keys = new Set([item.workLogId, item.workLogClientId]);
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [items]);
}
