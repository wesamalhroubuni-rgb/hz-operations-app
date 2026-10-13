import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';

/**
 * Everything the integration tests know about their database.
 *
 * SAFETY: the suite truncates every table between tests. It must therefore never be pointed at
 * the development database. `resolveTestDatabase` is the single gate: it refuses any target whose
 * database name does not end in `_test` or that is the database of `DATABASE_URL`. Every entry
 * point (global setup, per-worker setup, the test app, the truncate helper) goes through it.
 */

export interface TestDatabaseTarget {
  /** Connection string of the test database (the value of DATABASE_URL_TEST). */
  url: string;
  /** Database name, always ending in `_test`. */
  database: string;
  /** Connection string of the `postgres` maintenance database on the same server. */
  maintenanceUrl: string;
}

export class UnsafeTestDatabaseError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to run the integration tests: ${reason}\n` +
        'Set DATABASE_URL_TEST in the root .env to a separate database whose name ends in ' +
        '"_test" (see .env.example). The tests delete all data in that database.',
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

const SAFE_NAME = /^[A-Za-z0-9_]+_test$/;

interface ParsedUrl {
  url: URL;
  database: string;
}

function parse(name: string, value: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The value is deliberately not echoed: it holds a password.
    throw new UnsafeTestDatabaseError(`${name} is not a valid connection string.`);
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new UnsafeTestDatabaseError(`${name} must be a postgresql:// connection string.`);
  }
  return { url, database: decodeURIComponent(url.pathname.replace(/^\/+/, '')) };
}

/** Host and port of a connection string, with the PostgreSQL defaults filled in. */
function serverOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  const normalizedHost = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
  return `${normalizedHost}:${url.port || '5432'}`;
}

/**
 * Returns the test database to use, or throws {@link UnsafeTestDatabaseError}.
 *
 * Rules:
 * - `DATABASE_URL_TEST` must be set and be a postgresql:// URL;
 * - its database name must end in `_test` (letters, digits and underscores only);
 * - it must not be the database `DATABASE_URL` points at: a different name is required whenever
 *   `DATABASE_URL` is set, whatever the server.
 */
export function resolveTestDatabase(env: Record<string, string | undefined>): TestDatabaseTarget {
  const raw = env.DATABASE_URL_TEST?.trim();
  if (!raw) {
    throw new UnsafeTestDatabaseError('DATABASE_URL_TEST is not set.');
  }
  const test = parse('DATABASE_URL_TEST', raw);
  if (!SAFE_NAME.test(test.database)) {
    throw new UnsafeTestDatabaseError(
      `the database name of DATABASE_URL_TEST ("${test.database}") must end in "_test" and ` +
        'contain only letters, digits and underscores.',
    );
  }

  const devRaw = env.DATABASE_URL?.trim();
  if (devRaw) {
    const dev = parse('DATABASE_URL', devRaw);
    if (dev.database === test.database) {
      throw new UnsafeTestDatabaseError(
        `DATABASE_URL_TEST and DATABASE_URL name the same database ("${test.database}"` +
          `${serverOf(dev.url) === serverOf(test.url) ? '' : ', on different servers'}).`,
      );
    }
  }

  const maintenance = new URL(test.url.toString());
  maintenance.pathname = '/postgres';
  return { url: raw, database: test.database, maintenanceUrl: maintenance.toString() };
}

/**
 * Where `redirectDatabaseUrl` keeps the DATABASE_URL the process started with (empty when there
 * was none), so the guard keeps comparing against the real development database after
 * DATABASE_URL itself has been pointed at the test database.
 */
export const ORIGINAL_DATABASE_URL_KEY = 'OPS_TEST_ORIGINAL_DATABASE_URL';

/**
 * Resolves the target and then points `DATABASE_URL` at it, so that no code in this process (a
 * stray PrismaClient, a child process) can reach the development database. Safe to call
 * repeatedly: later calls still check against the DATABASE_URL the process started with.
 */
export function redirectDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): TestDatabaseTarget {
  const original = env[ORIGINAL_DATABASE_URL_KEY] ?? env.DATABASE_URL ?? '';
  const target = resolveTestDatabase({
    DATABASE_URL_TEST: env.DATABASE_URL_TEST,
    DATABASE_URL: original,
  });
  env[ORIGINAL_DATABASE_URL_KEY] = original;
  env.DATABASE_URL = target.url;
  return target;
}

/** Creates the test database when it does not exist yet. */
export async function ensureTestDatabase(target: TestDatabaseTarget): Promise<boolean> {
  const client = new Client({ connectionString: target.maintenanceUrl });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      target.database,
    ]);
    if (existing.rowCount && existing.rowCount > 0) {
      return false;
    }
    // The name passed SAFE_NAME (letters, digits, underscores), so quoting it is enough.
    await client.query(`CREATE DATABASE "${target.database}"`);
    return true;
  } finally {
    await client.end();
  }
}

/** Applies every migration to the test database with `prisma migrate deploy`. */
export function applyMigrations(target: TestDatabaseTarget): void {
  const apiRoot = resolve(__dirname, '..', '..');
  const prismaCli = require.resolve('prisma/build/index.js', { paths: [apiRoot] });
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiRoot,
      // DATABASE_URL is overridden for this child process only: prisma.config.ts reads it.
      env: { ...process.env, DATABASE_URL: target.url },
      stdio: 'pipe',
    });
  } catch (error) {
    const output =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    throw new Error(`prisma migrate deploy failed on "${target.database}":\n${output}`, {
      cause: error,
    });
  }
}

/** The slice of a database client the truncate helper needs. */
export interface RawQueryClient {
  $queryRawUnsafe<Result = unknown>(query: string): Promise<Result>;
  $executeRawUnsafe(query: string): Promise<number>;
}

/**
 * Empties every table of the connected database (business and platform tables alike) and
 * restarts the sequences. It first asks the server which database it is connected to and
 * refuses anything that is not the resolved test database.
 *
 * TRUNCATE is used on purpose: the append-only trigger on "AuditEvent" blocks UPDATE and DELETE
 * for each row, and TRUNCATE does not fire row triggers.
 */
export async function truncateAll(db: RawQueryClient, target: TestDatabaseTarget): Promise<void> {
  const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>(
    'SELECT current_database() AS name',
  );
  if (!current || current.name !== target.database || !SAFE_NAME.test(current.name)) {
    throw new UnsafeTestDatabaseError(
      `the connection is on database "${current?.name ?? 'unknown'}", not "${target.database}".`,
    );
  }
  const tables = await db.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
     ORDER BY tablename`,
  );
  if (tables.length === 0) {
    return;
  }
  const list = tables.map((table) => `"${table.tablename.replaceAll('"', '""')}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
