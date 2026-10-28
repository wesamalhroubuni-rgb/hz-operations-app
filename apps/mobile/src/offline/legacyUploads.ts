import { z } from 'zod';

import type { KeyValueStore } from '../storage/keyValueStore';
import { localPhotoSchema, type LocalPhoto } from '../storage/localPhoto';
import type { OfflineLocalStore } from './localStore';
import type { LocalPhotoStore, QueuedMutation } from './types';
import type { OfflineWriteQueue } from './writeQueue';

// The Phase 4 photo upload queue lived in AsyncStorage (`ops.uploads.pending.<userId>`). On the
// first open of a user's offline database its entries become `uploadAttachment` items of the
// write queue (with the log's known server id) and the key is deleted (ADR-0008 section 8). The
// 14-day deletion of queued photos is gone: queued data is never deleted silently.

export const UPLOAD_QUEUE_KEY_PREFIX = 'ops.uploads.pending.';

export function uploadQueueKey(userId: string): string {
  return `${UPLOAD_QUEUE_KEY_PREFIX}${userId}`;
}

export const legacyQueueSchema = z.array(
  z.object({
    workLogId: z.string().min(1),
    photo: localPhotoSchema,
    checkpoint: z.object({ attachmentId: z.string().nullable(), stored: z.boolean() }),
    failed: z.boolean().optional(),
    error: z.string().nullable().optional(),
    queuedAt: z.string().optional(),
  }),
);
export type LegacyQueueEntry = z.infer<typeof legacyQueueSchema>[number];

/** The entries of a stored Phase 4 queue; an unreadable value gives none. */
export function parseLegacyQueue(raw: string | null): LegacyQueueEntry[] {
  if (raw === null) return [];
  try {
    const parsed = legacyQueueSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export interface LegacyMigrationDeps {
  kv: KeyValueStore;
  userId: string;
  store: OfflineLocalStore;
  queue: OfflineWriteQueue;
  photos: LocalPhotoStore;
  newId: () => string;
  now: Date;
}

/**
 * Moves the user's Phase 4 upload queue into the write queue. Safe to run again after a crash:
 * a photo already queued (same local id) is not queued twice. Returns how many photos moved.
 */
export async function migrateLegacyUploads(deps: LegacyMigrationDeps): Promise<number> {
  const key = uploadQueueKey(deps.userId);
  let raw: string | null;
  try {
    raw = await deps.kv.getItem(key);
  } catch {
    return 0;
  }
  if (raw === null) return 0;
  const entries = parseLegacyQueue(raw);
  const mutations: QueuedMutation[] = [];
  for (const entry of entries) {
    let photo: LocalPhoto = entry.photo;
    try {
      // Into the user's photo folder. When it does not fit (or the file is gone), the photo is
      // queued where it is: the item then fails visibly instead of disappearing.
      const saved = await deps.photos.save(photo);
      if (saved.ok) photo = saved.photo;
    } catch {
      // Keep the old location.
    }
    const cached = await deps.store.get('workLogs', entry.workLogId);
    mutations.push({
      kind: 'uploadAttachment',
      // A log saved online in Phase 4 has a clientId; when the cache does not know it yet, the
      // server id stands in for it (the record key only orders this log's items).
      workLogClientId: cached?.clientId ?? entry.workLogId,
      workLogId: entry.workLogId,
      attachmentClientId: deps.newId(),
      photo,
      checkpoint: { ...entry.checkpoint },
    });
  }
  await deps.queue.enqueueAll(mutations, deps.now);
  try {
    await deps.kv.removeItem(key);
  } catch {
    // The next open finds the same entries; the queue does not take them twice.
  }
  return mutations.length;
}
