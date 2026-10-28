import { ApiException } from '../../platform/http';
import type { Db } from './db';

/**
 * Optimistic concurrency (ADR-0008 section 1). Every change of a task or a work log raises its
 * `version` by one in the same transaction ({@link NEXT_VERSION}). A client that sends
 * `expectedVersion` gets 409 `version_conflict` when the record moved on since it read it; the
 * caller decides beforehand whether the request is a no-op (then it answers 200 with the current
 * record instead, so a resend after a lost answer succeeds).
 */
export const NEXT_VERSION = { increment: 1 } as const;

export function assertExpectedVersion(
  entity: string,
  id: string,
  current: number,
  expected: number | undefined,
): void {
  if (expected !== undefined && expected !== current) {
    throw ApiException.of(
      'version_conflict',
      `${entity} ${id} was changed by somebody else (version ${current}, expected ${expected})`,
      [{ path: 'expectedVersion', message: `the current version is ${current}` }],
    );
  }
}

/**
 * Locks the row until the end of the transaction, so the version read next cannot change
 * before this transaction writes (two concurrent changes with the same `expectedVersion`: the
 * second waits, then sees the new version and answers 409).
 */
export async function lockRowForUpdate(
  db: Db,
  table: 'Task' | 'WorkLog',
  id: string,
): Promise<void> {
  if (table === 'Task') {
    await db.$executeRaw`SELECT 1 FROM "Task" WHERE "id" = ${id}::uuid FOR UPDATE`;
  } else {
    await db.$executeRaw`SELECT 1 FROM "WorkLog" WHERE "id" = ${id}::uuid FOR UPDATE`;
  }
}
