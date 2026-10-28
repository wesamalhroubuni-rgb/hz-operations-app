import { SYNC_RESOURCES, type SyncPullResponse } from '@ops/shared';

import type { OfflineDatabase, OfflineTable, OfflineTableAccess } from './db';
import type { CachedResourceName, CachedResources, LocalStore, SyncMeta } from './types';

// The signed-in user's read cache (ADR-0008): what the last `GET /sync/pull` returned, one table
// per resource, plus the sync meta. The server is the source of truth: a pull replaces and prunes
// the cache. Queued writes are not stored here; the optimistic view on top of the cache is
// computed by `localView.ts`.

export const RESOURCE_TABLES: Readonly<Record<CachedResourceName, OfflineTable>> = {
  tasks: 'cache_tasks',
  logTypes: 'cache_log_types',
  sites: 'cache_sites',
  teams: 'cache_teams',
  workLogs: 'cache_work_logs',
  notifications: 'cache_notifications',
};

const META_KEYS = {
  cursor: 'sync.cursor',
  lastRefreshedAt: 'sync.lastRefreshedAt',
  lastServerTime: 'sync.lastServerTime',
  organization: 'sync.organization',
} as const satisfies Record<keyof SyncMeta, string>;

/** What applying one pull found. */
export interface PullReport {
  /**
   * Ids the server listed that are neither cached nor in `upserts` (should not happen; the engine
   * then pulls again without a cursor, ADR-0008 section 6).
   */
  missingIds: number;
}

/** The local store with the extras the app's data layer uses. */
export interface OfflineLocalStore extends LocalStore {
  /** {@link LocalStore.applyPull} that also reports ids the pull could not account for. */
  applyPullWithReport(pull: SyncPullResponse, refreshedAt: Date): Promise<PullReport>;
  /** A small JSON value kept with the cache (e.g. the last known scope). Null when absent. */
  getValue<Value>(key: string): Promise<Value | null>;
  setValue(key: string, value: unknown): Promise<void>;
}

function parse<Value>(raw: string | null): Value | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Value;
  } catch {
    return null;
  }
}

async function readAll<Name extends CachedResourceName>(
  access: OfflineTableAccess,
  resource: Name,
): Promise<CachedResources[Name][]> {
  const rows = await access.all(RESOURCE_TABLES[resource]);
  const records: CachedResources[Name][] = [];
  for (const row of rows) {
    const record = parse<CachedResources[Name]>(row.value);
    if (record !== null) records.push(record);
  }
  return records;
}

async function writeAll(
  access: OfflineTableAccess,
  resource: CachedResourceName,
  records: readonly { id: string }[],
): Promise<void> {
  for (const record of records) {
    await access.put(RESOURCE_TABLES[resource], record.id, JSON.stringify(record));
  }
}

async function keepOnly(
  access: OfflineTableAccess,
  resource: CachedResourceName,
  ids: readonly string[],
): Promise<void> {
  const keep = new Set(ids);
  for (const row of await access.all(RESOURCE_TABLES[resource])) {
    if (!keep.has(row.key)) await access.remove(RESOURCE_TABLES[resource], row.key);
  }
}

export function createLocalStore(db: OfflineDatabase, userId: string): OfflineLocalStore {
  const listeners = new Set<(resource: CachedResourceName) => void>();

  function notify(resources: readonly CachedResourceName[]): void {
    for (const resource of resources) {
      for (const listener of [...listeners]) {
        try {
          listener(resource);
        } catch {
          // A listener's failure must not break the store.
        }
      }
    }
  }

  async function applyPullWithReport(
    pull: SyncPullResponse,
    refreshedAt: Date,
  ): Promise<PullReport> {
    const report = await db.transaction(async (tx) => {
      let missingIds = 0;
      for (const resource of SYNC_RESOURCES) {
        const part = pull[resource];
        if (pull.full) await tx.removeAll(RESOURCE_TABLES[resource]);
        await writeAll(tx, resource, part.upserts);
        await keepOnly(tx, resource, part.ids);
        const present = new Set((await tx.all(RESOURCE_TABLES[resource])).map((row) => row.key));
        missingIds += part.ids.filter((id) => !present.has(id)).length;
      }
      await tx.put('meta', META_KEYS.cursor, JSON.stringify(pull.cursor));
      await tx.put('meta', META_KEYS.lastRefreshedAt, JSON.stringify(refreshedAt.toISOString()));
      await tx.put('meta', META_KEYS.lastServerTime, JSON.stringify(pull.serverTime));
      await tx.put('meta', META_KEYS.organization, JSON.stringify(pull.organization));
      return { missingIds };
    });
    notify(SYNC_RESOURCES);
    return report;
  }

  return {
    userId,

    list: (resource) => readAll(db, resource),

    async get(resource, id) {
      return parse(await db.get(RESOURCE_TABLES[resource], id));
    },

    async getWorkLogByClientId(clientId) {
      const logs = await readAll(db, 'workLogs');
      return logs.find((log) => log.clientId === clientId) ?? null;
    },

    async upsert(resource, records) {
      if (records.length === 0) return;
      await db.transaction((tx) => writeAll(tx, resource, records));
      notify([resource]);
    },

    async retainOnly(resource, ids) {
      await db.transaction((tx) => keepOnly(tx, resource, ids));
      notify([resource]);
    },

    async replaceAll(resource, records) {
      await db.transaction(async (tx) => {
        await tx.removeAll(RESOURCE_TABLES[resource]);
        await writeAll(tx, resource, records);
      });
      notify([resource]);
    },

    async getSyncMeta() {
      const [cursor, lastRefreshedAt, lastServerTime, organization] = await Promise.all([
        db.get('meta', META_KEYS.cursor),
        db.get('meta', META_KEYS.lastRefreshedAt),
        db.get('meta', META_KEYS.lastServerTime),
        db.get('meta', META_KEYS.organization),
      ]);
      return {
        cursor: parse<string>(cursor),
        lastRefreshedAt: parse<string>(lastRefreshedAt),
        lastServerTime: parse<string>(lastServerTime),
        organization: parse<SyncMeta['organization']>(organization),
      };
    },

    async setSyncMeta(meta) {
      await db.transaction(async (tx) => {
        for (const [name, key] of Object.entries(META_KEYS) as [keyof SyncMeta, string][]) {
          if (meta[name] !== undefined) await tx.put('meta', key, JSON.stringify(meta[name]));
        }
      });
    },

    async applyPull(pull, refreshedAt) {
      await applyPullWithReport(pull, refreshedAt);
    },

    applyPullWithReport,

    async clearCache() {
      await db.transaction(async (tx) => {
        for (const table of Object.values(RESOURCE_TABLES)) await tx.removeAll(table);
        for (const row of await tx.all('meta')) {
          // Keeps the queue's own counters (`queue.*`); everything else belongs to the cache.
          if (!row.key.startsWith('queue.')) await tx.remove('meta', row.key);
        }
      });
      notify(SYNC_RESOURCES);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close: () => db.close(),

    async getValue<Value>(key: string) {
      return parse<Value>(await db.get('meta', `value.${key}`));
    },

    async setValue(key, value) {
      await db.put('meta', `value.${key}`, JSON.stringify(value));
    },
  };
}
