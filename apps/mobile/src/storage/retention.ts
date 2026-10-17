import { UPLOAD_QUEUE_KEY_PREFIX, pruneStaleQueue } from '../data/uploadQueue';
import { DRAFT_KEY_PREFIX, isDraftStale } from './draftStore';
import type { KeyValueStore } from './keyValueStore';

// Work data does not stay on a phone forever. At app start, drafts and queued photo uploads
// older than LOCAL_DATA_MAX_AGE_DAYS are deleted, with their local photo files, for EVERY user
// who has used the phone (not only the one signed in): a shared phone handed to a colleague,
// or one that is lost, should not keep a former user's photos and notes indefinitely.

export const LOCAL_DATA_MAX_AGE_DAYS = 14;
export const LOCAL_DATA_MAX_AGE_MS = LOCAL_DATA_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  store: KeyValueStore;
  deleteLocalFile: (uri: string) => Promise<void>;
  now?: Date;
  maxAgeMs?: number;
}

export interface RetentionResult {
  drafts: number;
  queuedPhotos: number;
}

/**
 * Deletes stale drafts and queued uploads of every user. A photo file still referenced by a
 * queued upload that is kept is never deleted. Never throws: storage failures leave the data for
 * the next start.
 */
export async function purgeStaleLocalData(deps: RetentionDeps): Promise<RetentionResult> {
  const result: RetentionResult = { drafts: 0, queuedPhotos: 0 };
  const now = deps.now ?? new Date();
  const maxAgeMs = deps.maxAgeMs ?? LOCAL_DATA_MAX_AGE_MS;
  const { store } = deps;
  if (!store.getAllKeys) return result;
  let keys: readonly string[];
  try {
    keys = await store.getAllKeys();
  } catch {
    return result;
  }

  const keptUris = new Set<string>();
  const doomedUris = new Set<string>();

  for (const key of keys.filter((candidate) => candidate.startsWith(UPLOAD_QUEUE_KEY_PREFIX))) {
    try {
      const pruned = pruneStaleQueue(await store.getItem(key), now, maxAgeMs);
      pruned.keptUris.forEach((uri) => keptUris.add(uri));
      pruned.expiredUris.forEach((uri) => doomedUris.add(uri));
      result.queuedPhotos += pruned.expiredUris.length;
      if (pruned.value === null) {
        await store.removeItem(key);
      } else if (pruned.changed) {
        await store.setItem(key, pruned.value);
      }
    } catch {
      // Left for the next start.
    }
  }

  for (const key of keys.filter((candidate) => candidate.startsWith(DRAFT_KEY_PREFIX))) {
    try {
      const draft = isDraftStale(await store.getItem(key), now, maxAgeMs);
      if (!draft.stale) continue;
      await store.removeItem(key);
      draft.photoUris.forEach((uri) => doomedUris.add(uri));
      result.drafts += 1;
    } catch {
      // Left for the next start.
    }
  }

  for (const uri of doomedUris) {
    if (!keptUris.has(uri)) {
      await deps.deleteLocalFile(uri).catch(() => undefined);
    }
  }
  return result;
}

let running: Promise<RetentionResult> | null = null;

/**
 * {@link purgeStaleLocalData} once per app process (the app start). Later calls get the same
 * promise, so the upload queue can wait for it before loading.
 */
export function purgeStaleLocalDataOnce(deps: RetentionDeps): Promise<RetentionResult> {
  running ??= purgeStaleLocalData(deps);
  return running;
}
