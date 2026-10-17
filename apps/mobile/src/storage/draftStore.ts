import { z } from 'zod';

import type { LogFormValues } from '../logic/logForm';
import { localPhotoSchema, type LocalPhoto } from './localPhoto';
import type { KeyValueStore } from './keyValueStore';

// Keeps the unsaved "New log" form on the phone, so leaving the screen, a crash or a restart
// does not lose what the worker typed. One draft per user (the key holds the user id, so a
// colleague signing in on the same phone never sees it). Written on every change (debounced by
// the caller), removed once the log is saved.

const DRAFT_VERSION = 1;

const locationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracy: z.number().nullable().optional(),
});

const formValuesSchema = z.object({
  clientId: z.string().min(1),
  logTypeId: z.string().nullable(),
  customFields: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
  text: z.string(),
  taskId: z.string().nullable(),
  siteId: z.string().nullable(),
  teamId: z.string().nullable(),
  occurredAt: z.string().nullable(),
  location: locationSchema.nullable(),
});

const draftSchema = z.object({
  version: z.literal(DRAFT_VERSION),
  savedAt: z.string(),
  values: formValuesSchema,
  photos: z.array(localPhotoSchema),
});

export interface LogDraft {
  savedAt: string;
  values: LogFormValues;
  photos: LocalPhoto[];
}

export const DRAFT_KEY_PREFIX = 'ops.drafts.newWorkLog.';

export function draftKey(userId: string): string {
  return `${DRAFT_KEY_PREFIX}${userId}`;
}

/**
 * Whether a stored draft (any user's) is older than `maxAgeMs`, and the local photo files it
 * holds. A draft that cannot be read is stale too (it would be dropped on load anyway).
 */
export function isDraftStale(
  raw: string | null,
  now: Date,
  maxAgeMs: number,
): { stale: boolean; photoUris: string[] } {
  if (raw === null) return { stale: false, photoUris: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { stale: true, photoUris: [] };
  }
  const result = draftSchema.safeParse(parsed);
  if (!result.success) return { stale: true, photoUris: [] };
  const savedAt = Date.parse(result.data.savedAt);
  const stale = !Number.isFinite(savedAt) || now.getTime() - savedAt > maxAgeMs;
  return { stale, photoUris: stale ? result.data.photos.map((photo) => photo.uri) : [] };
}

export interface DraftStore {
  load(userId: string): Promise<LogDraft | null>;
  save(userId: string, draft: Omit<LogDraft, 'savedAt'>, now?: Date): Promise<void>;
  clear(userId: string): Promise<void>;
}

/**
 * A draft that cannot be read (another app version, damaged) is dropped rather than crashing the
 * form. Storage failures are swallowed: the draft is a safety net, the form state in memory is
 * still there.
 */
export function createDraftStore(store: KeyValueStore): DraftStore {
  return {
    async load(userId) {
      let raw: string | null;
      try {
        raw = await store.getItem(draftKey(userId));
      } catch {
        return null;
      }
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const result = draftSchema.safeParse(parsed);
      if (!result.success) {
        await store.removeItem(draftKey(userId)).catch(() => undefined);
        return null;
      }
      return {
        savedAt: result.data.savedAt,
        values: result.data.values,
        photos: result.data.photos,
      };
    },
    async save(userId, draft, now = new Date()) {
      const value = JSON.stringify({
        version: DRAFT_VERSION,
        savedAt: now.toISOString(),
        values: draft.values,
        photos: draft.photos,
      });
      await store.setItem(draftKey(userId), value).catch(() => undefined);
    },
    async clear(userId) {
      await store.removeItem(draftKey(userId)).catch(() => undefined);
    },
  };
}

/**
 * Whether a form is worth keeping as a draft: anything typed, chosen or photographed beyond what
 * the screen pre-filled.
 */
export function isDraftWorthKeeping(
  values: LogFormValues,
  photos: readonly LocalPhoto[],
  prefill: Pick<LogFormValues, 'taskId' | 'siteId' | 'teamId'>,
): boolean {
  return (
    photos.length > 0 ||
    values.text.trim() !== '' ||
    values.logTypeId !== null ||
    values.occurredAt !== null ||
    values.taskId !== prefill.taskId ||
    values.siteId !== prefill.siteId ||
    values.teamId !== prefill.teamId ||
    Object.values(values.customFields).some((value) => value !== null && value !== '')
  );
}
