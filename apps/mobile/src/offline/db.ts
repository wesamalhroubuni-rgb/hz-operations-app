// The thin storage adapter under the offline layer (ADR-0008). The local store and the write
// queue keep JSON documents in a few named tables; this interface is everything they need from
// a database. `sqliteDatabase.ts` implements it on expo-sqlite (one file per user); the
// in-memory implementation below runs the same logic in Jest without native modules.
//
// Every table has the same two columns: `key` (primary key) and `value` (JSON text). Sorting and
// filtering happen in TypeScript: the sets are small (hundreds of rows for one worker).

/** The tables of a user's offline database. */
export const OFFLINE_TABLES = [
  'cache_tasks',
  'cache_log_types',
  'cache_sites',
  'cache_teams',
  'cache_work_logs',
  'cache_notifications',
  /** Sync cursor, last refresh, organization summary, and small app values. */
  'meta',
  /** The write queue (`QueueItem` documents). */
  'queue',
] as const;
export type OfflineTable = (typeof OFFLINE_TABLES)[number];

export interface OfflineRow {
  key: string;
  value: string;
}

/** The operations available inside and outside a transaction. */
export interface OfflineTableAccess {
  get(table: OfflineTable, key: string): Promise<string | null>;
  /** Every row of the table, in key order. */
  all(table: OfflineTable): Promise<OfflineRow[]>;
  put(table: OfflineTable, key: string, value: string): Promise<void>;
  remove(table: OfflineTable, key: string): Promise<void>;
  removeAll(table: OfflineTable): Promise<void>;
}

export interface OfflineDatabase extends OfflineTableAccess {
  /**
   * Runs `work` atomically: all its writes are kept, or none when it throws. Operations of the
   * database run one at a time, so nothing interleaves with a transaction.
   */
  transaction<Result>(work: (tx: OfflineTableAccess) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

/**
 * Runs async tasks one after the other. Every operation of a database goes through one, so a
 * read-modify-write inside a transaction never interleaves with another call.
 */
export function createSerialRunner() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<Result>(task: () => Promise<Result>): Promise<Result> {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** The in-memory database of the tests (and of nothing else). */
export function createMemoryDatabase(): OfflineDatabase & {
  /** A copy of every table, for assertions. */
  dump(): Record<OfflineTable, Record<string, string>>;
  readonly closed: boolean;
} {
  let tables = new Map<OfflineTable, Map<string, string>>(
    OFFLINE_TABLES.map((table) => [table, new Map()]),
  );
  let closed = false;
  const run = createSerialRunner();

  function table(name: OfflineTable): Map<string, string> {
    if (closed) throw new Error('The offline database is closed');
    const found = tables.get(name);
    if (!found) throw new Error(`Unknown table ${name}`);
    return found;
  }

  const access: OfflineTableAccess = {
    get: async (name, key) => table(name).get(key) ?? null,
    all: async (name) =>
      [...table(name).entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ key, value })),
    put: async (name, key, value) => {
      table(name).set(key, value);
    },
    remove: async (name, key) => {
      table(name).delete(key);
    },
    removeAll: async (name) => {
      table(name).clear();
    },
  };

  return {
    get: (name, key) => run(() => access.get(name, key)),
    all: (name) => run(() => access.all(name)),
    put: (name, key, value) => run(() => access.put(name, key, value)),
    remove: (name, key) => run(() => access.remove(name, key)),
    removeAll: (name) => run(() => access.removeAll(name)),
    transaction: (work) =>
      run(async () => {
        const snapshot = new Map(
          [...tables.entries()].map(([name, rows]) => [name, new Map(rows)] as const),
        );
        try {
          return await work(access);
        } catch (error) {
          tables = snapshot;
          throw error;
        }
      }),
    close: async () => {
      closed = true;
    },
    dump: () =>
      Object.fromEntries(
        [...tables.entries()].map(([name, rows]) => [name, Object.fromEntries(rows)]),
      ) as Record<OfflineTable, Record<string, string>>,
    get closed() {
      return closed;
    },
  };
}
