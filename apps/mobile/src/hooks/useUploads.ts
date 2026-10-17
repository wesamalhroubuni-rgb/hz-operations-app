import { useMemo, useSyncExternalStore } from 'react';

import { useData } from '../data/DataProvider';
import type { QueuedPhoto } from '../data/uploadQueue';

/** Every photo still waiting to reach the server, live. */
export function useUploadQueue(): readonly QueuedPhoto[] {
  const { uploads } = useData();
  return useSyncExternalStore(uploads.subscribe, () => uploads.getState()).items;
}

/** The queued photos of one log. */
export function useLogUploads(workLogId: string): readonly QueuedPhoto[] {
  const items = useUploadQueue();
  return useMemo(() => items.filter((item) => item.workLogId === workLogId), [items, workLogId]);
}

/** How many photos each log still has to upload. */
export function usePendingPhotoCounts(): ReadonlyMap<string, number> {
  const items = useUploadQueue();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.workLogId, (counts.get(item.workLogId) ?? 0) + 1);
    return counts;
  }, [items]);
}
