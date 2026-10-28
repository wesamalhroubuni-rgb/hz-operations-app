import { parseLegacyQueue, UPLOAD_QUEUE_KEY_PREFIX } from '../offline/legacyUploads';
import { DRAFT_KEY_PREFIX, EDIT_DRAFT_KEY_PREFIX, isDraftStale } from './draftStore';
import type { KeyValueStore } from './keyValueStore';

// Unsaved form drafts do not stay on a phone forever. At app start, drafts (new-log and edit
// forms) older than LOCAL_DATA_MAX_AGE_DAYS are deleted, with their local photo files, for EVERY
// user who has used the phone (not only the one signed in): a shared phone handed to a
// colleague, or one that is lost, should not keep a former user's photos and notes indefinitely.
//
// Queued writes and their photos are NOT deleted by age (ADR-0008): they live in the user's
// offline database until sent or discarded by the worker, and the kept-queue rule of a signed-out
// user is applied by `OfflineSessionFactory.sweepAbandoned`. A photo still referenced by a
// Phase 4 upload queue that was not migrated yet is never deleted here.

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
}

/** Deletes stale drafts of every user. Never throws: failures leave data for the next start. */
export async function purgeStaleLocalData(deps: RetentionDeps): Promise<RetentionResult> {
  const result: RetentionResult = { drafts: 0 };
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
      for (const entry of parseLegacyQueue(await store.getItem(key))) keptUris.add(entry.photo.uri);
    } catch {
      // Unreadable: nothing is deleted on its account.
    }
  }

  const draftKeys = keys.filter(
    (candidate) =>
      candidate.startsWith(DRAFT_KEY_PREFIX) || candidate.startsWith(EDIT_DRAFT_KEY_PREFIX),
  );
  for (const key of draftKeys) {
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

/** {@link purgeStaleLocalData} once per app process (the app start). */
export function purgeStaleLocalDataOnce(deps: RetentionDeps): Promise<RetentionResult> {
  running ??= purgeStaleLocalData(deps);
  return running;
}
