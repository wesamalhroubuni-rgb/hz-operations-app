import { authUserSchema, type AuthUser } from '@ops/shared';
import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

import type { SecureStoreLike } from '../auth/token-storage';
import type { KeyValueStore } from '../storage/keyValueStore';
import { KEPT_QUEUE_MAX_DAYS, type OfflineIdentityStore } from './types';

// Who the phone's offline data belongs to (ADR-0008 sections 8 and 11).
//
// - The offline identity: the last signed-in user, kept in SecureStore next to the tokens, so the
//   app can open with that user's cache and queue when the server cannot be reached. Removed at
//   sign-out. Never a token or a password: the public profile the API returned at sign-in.
// - The kept-queue register (AsyncStorage): users whose offline data stays on the phone without
//   them being signed in, and since when: signed out with "keep for later", or replaced by
//   another user while their sign-in had expired. The start-up sweep deletes their database and
//   photos after KEPT_QUEUE_MAX_DAYS; `deleteNow` marks data to delete at the next sweep (a
//   sign-out cleanup interrupted by the app dying).

export const OFFLINE_IDENTITY_KEY = 'ops.auth.offlineIdentity';

/** Same protection as the tokens: this device only, readable while unlocked. */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** The identity store with a synchronous snapshot and change notifications, for React. */
export interface ObservableIdentityStore extends OfflineIdentityStore {
  /** The last loaded or saved identity; `undefined` until the first `load()` finished. */
  current(): AuthUser | null | undefined;
  subscribe(listener: () => void): () => void;
}

export function createOfflineIdentityStore(
  store: SecureStoreLike,
  options: SecureStore.SecureStoreOptions = SECURE_OPTIONS,
): ObservableIdentityStore {
  let snapshot: AuthUser | null | undefined;
  const listeners = new Set<() => void>();
  const set = (next: AuthUser | null) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    current: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      let user: AuthUser | null = null;
      try {
        const raw = await store.getItemAsync(OFFLINE_IDENTITY_KEY, options);
        if (raw !== null) {
          const parsed = authUserSchema.safeParse(JSON.parse(raw));
          user = parsed.success ? parsed.data : null;
          if (!parsed.success) await store.deleteItemAsync(OFFLINE_IDENTITY_KEY, options);
        }
      } catch {
        user = null;
      }
      set(user);
      return user;
    },
    async save(user) {
      set(user);
      try {
        await store.setItemAsync(OFFLINE_IDENTITY_KEY, JSON.stringify(user), options);
      } catch {
        // The app keeps working from memory; the next sign-in writes it again.
      }
    },
    async clear() {
      set(null);
      try {
        await store.deleteItemAsync(OFFLINE_IDENTITY_KEY, options);
      } catch {
        // Nothing more to do.
      }
    },
  };
}

export const KEPT_QUEUES_KEY = 'ops.offline.keptUsers';

const keptEntrySchema = z.object({
  /** When the user's data stopped belonging to the signed-in user (ISO). */
  since: z.string(),
  /** Delete at the next sweep regardless of age (an interrupted sign-out cleanup). */
  deleteNow: z.boolean().default(false),
  /**
   * The user chose "keep for later" at sign-out and was told the data goes after
   * KEPT_QUEUE_MAX_DAYS. Only such entries age out. A user kept only because their session
   * expired and somebody else signed in is NEVER swept automatically (ADR-0008 section 8).
   */
  explicit: z.boolean().default(false),
});
const keptSchema = z.record(z.string(), keptEntrySchema);
export type KeptUsers = z.infer<typeof keptSchema>;

export interface KeptUsersRegister {
  all(): Promise<KeptUsers>;
  /**
   * Registers a user's data as kept since `now` (an earlier date is kept). `explicit`: the user
   * chose "keep for later" at sign-out (the 30-day clock starts then); otherwise the entry only
   * records that the data is not the signed-in user's and is never swept by age.
   */
  keep(userId: string, now: Date, options?: { explicit?: boolean }): Promise<void>;
  /** Registers a user's data for deletion at the next sweep. */
  deleteSoon(userId: string, now: Date): Promise<void>;
  /** The user is back (signed in): their data is theirs again. */
  release(userId: string): Promise<void>;
  /** The users whose data must be deleted now, never `except`. */
  due(now: Date, except: readonly string[]): Promise<string[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createKeptUsersRegister(store: KeyValueStore): KeptUsersRegister {
  async function read(): Promise<KeptUsers> {
    try {
      const raw = await store.getItem(KEPT_QUEUES_KEY);
      if (raw === null) return {};
      const parsed = keptSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }
  async function write(value: KeptUsers): Promise<void> {
    if (Object.keys(value).length === 0) await store.removeItem(KEPT_QUEUES_KEY);
    else await store.setItem(KEPT_QUEUES_KEY, JSON.stringify(value));
  }
  return {
    all: read,
    async keep(userId, now, options = {}) {
      const value = await read();
      const previous = value[userId];
      const explicit = options.explicit === true || previous?.explicit === true;
      // The explicit choice starts its own clock: an earlier implicit entry does not shorten it.
      const since =
        options.explicit === true && previous?.explicit !== true
          ? now.toISOString()
          : (previous?.since ?? now.toISOString());
      value[userId] = { since, deleteNow: previous?.deleteNow ?? false, explicit };
      await write(value);
    },
    async deleteSoon(userId, now) {
      const value = await read();
      value[userId] = {
        since: value[userId]?.since ?? now.toISOString(),
        deleteNow: true,
        explicit: value[userId]?.explicit ?? false,
      };
      await write(value);
    },
    async release(userId) {
      const value = await read();
      if (!(userId in value)) return;
      delete value[userId];
      await write(value);
    },
    async due(now, except) {
      const value = await read();
      const skip = new Set(except);
      return Object.entries(value)
        .filter(([userId, entry]) => {
          if (skip.has(userId)) return false;
          if (entry.deleteNow) return true;
          if (!entry.explicit) return false;
          const since = Date.parse(entry.since);
          return !Number.isFinite(since) || now.getTime() - since > KEPT_QUEUE_MAX_DAYS * DAY_MS;
        })
        .map(([userId]) => userId);
    },
  };
}
