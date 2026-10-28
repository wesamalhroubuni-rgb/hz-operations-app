import type { KeyValueStore } from '../storage/keyValueStore';
import type { DroppedReference } from './engine';

// Notices the engine leaves for the worker after a queued write was accepted with a change: an
// offline create whose task, site or team link the server dropped (ADR-0008 section 3). The API
// records the dropped fields only in the audit log, so the engine compares what it sent with
// what came back and keeps the result here, per user, by the log's clientId. Holds field names
// and ids only (no notes, photos or locations); entries older than 30 days, or beyond 200, go.

export const DROPPED_REFERENCES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DROPPED_REFERENCES_MAX_ENTRIES = 200;

interface Entry {
  fields: DroppedReference[];
  at: string;
}

export interface DroppedReferenceNotices {
  record(clientId: string, fields: readonly DroppedReference[], at: Date): Promise<void>;
  get(clientId: string): Promise<DroppedReference[] | null>;
  subscribe(listener: () => void): () => void;
}

export function droppedReferencesKey(userId: string): string {
  return `ops.sync.droppedReferences.${userId}`;
}

export function createDroppedReferenceNotices(
  kv: KeyValueStore,
  userId: string,
  clock: () => Date = () => new Date(),
): DroppedReferenceNotices {
  const key = droppedReferencesKey(userId);
  const listeners = new Set<() => void>();

  async function load(): Promise<Record<string, Entry>> {
    try {
      const raw = await kv.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, Entry>) : {};
    } catch {
      return {};
    }
  }

  function fresh(entries: Record<string, Entry>): [string, Entry][] {
    const cutoff = clock().getTime() - DROPPED_REFERENCES_MAX_AGE_MS;
    return Object.entries(entries)
      .filter(([, entry]) => Date.parse(entry.at) >= cutoff)
      .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
      .slice(0, DROPPED_REFERENCES_MAX_ENTRIES);
  }

  return {
    async record(clientId, fields, at) {
      if (fields.length === 0) return;
      const entries = await load();
      entries[clientId] = { fields: [...fields], at: at.toISOString() };
      await kv.setItem(key, JSON.stringify(Object.fromEntries(fresh(entries))));
      for (const listener of listeners) listener();
    },
    async get(clientId) {
      const entry = fresh(await load()).find(([id]) => id === clientId);
      return entry ? entry[1].fields : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
