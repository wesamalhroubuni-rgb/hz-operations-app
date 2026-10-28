import * as SQLite from 'expo-sqlite';

import {
  createSerialRunner,
  OFFLINE_TABLES,
  type OfflineDatabase,
  type OfflineTable,
  type OfflineTableAccess,
} from './db';

// The offline database on the phone: one SQLite file per signed-in user, `ops-<userId>.db`, in
// the app's private database directory (expo-sqlite's default). Nothing of one user is ever
// opened under another user's id. The schema is versioned with `PRAGMA user_version`: every
// entry of MIGRATIONS runs once, in order, inside a transaction.

/** The file name of a user's database. Never contains a client name. */
export function userDatabaseName(userId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(userId)) {
    throw new Error('A user id for the offline database must be a plain id');
  }
  return `ops-${userId}.db`;
}

const keyValueTable = (name: OfflineTable) =>
  `CREATE TABLE IF NOT EXISTS ${name} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`;

/**
 * Schema migrations. Index + 1 is the `user_version` after the step. Append only: never change
 * a step that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: Phase 5 (ADR-0008): read cache per resource, meta, write queue.
  OFFLINE_TABLES.map(keyValueTable).join('\n'),
];

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const current = row?.user_version ?? 0;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const step = MIGRATIONS[version] ?? '';
    await db.withTransactionAsync(async () => {
      await db.execAsync(step);
      // PRAGMA does not take bound parameters; the value is a number we computed.
      await db.execAsync(`PRAGMA user_version = ${version + 1};`);
    });
  }
}

function isTable(name: string): name is OfflineTable {
  return (OFFLINE_TABLES as readonly string[]).includes(name);
}

function accessOf(db: SQLite.SQLiteDatabase): OfflineTableAccess {
  // Table names come from the fixed list above (checked), values are always bound parameters.
  const checked = (name: OfflineTable): OfflineTable => {
    if (!isTable(name)) throw new Error(`Unknown table ${String(name)}`);
    return name;
  };
  return {
    async get(name, key) {
      const row = await db.getFirstAsync<{ value: string }>(
        `SELECT value FROM ${checked(name)} WHERE key = ?;`,
        key,
      );
      return row?.value ?? null;
    },
    all(name) {
      return db.getAllAsync<{ key: string; value: string }>(
        `SELECT key, value FROM ${checked(name)} ORDER BY key;`,
      );
    },
    async put(name, key, value) {
      await db.runAsync(
        `INSERT OR REPLACE INTO ${checked(name)} (key, value) VALUES (?, ?);`,
        key,
        value,
      );
    },
    async remove(name, key) {
      await db.runAsync(`DELETE FROM ${checked(name)} WHERE key = ?;`, key);
    },
    async removeAll(name) {
      await db.runAsync(`DELETE FROM ${checked(name)};`);
    },
  };
}

/** Opens (creating and migrating if needed) the database of `userId`. */
export async function openUserDatabase(userId: string): Promise<OfflineDatabase> {
  const db = await SQLite.openDatabaseAsync(userDatabaseName(userId));
  await migrate(db);
  const access = accessOf(db);
  const run = createSerialRunner();
  return {
    get: (name, key) => run(() => access.get(name, key)),
    all: (name) => run(() => access.all(name)),
    put: (name, key, value) => run(() => access.put(name, key, value)),
    remove: (name, key) => run(() => access.remove(name, key)),
    removeAll: (name) => run(() => access.removeAll(name)),
    transaction: (work) =>
      run(async () => {
        let result: Awaited<ReturnType<typeof work>> | undefined;
        // Every call is serialised by `run`, so nothing else uses the connection meanwhile.
        await db.withTransactionAsync(async () => {
          result = await work(access);
        });
        return result as Awaited<ReturnType<typeof work>>;
      }),
    close: () => run(() => db.closeAsync()),
  };
}

/** Deletes the database file of `userId` (it must be closed). A missing file is fine. */
export async function deleteUserDatabase(userId: string): Promise<void> {
  try {
    await SQLite.deleteDatabaseAsync(userDatabaseName(userId));
  } catch {
    // Already gone, or never created.
  }
}
