import type { Prisma } from '../../generated/prisma/client';
import { escapeLike } from '../../platform/http';

/** A database handle a helper can run on: the client itself or a transaction of it. */
export type Db = Prisma.TransactionClient;

/** ISO string of a date, as sent over the wire. */
export function iso(date: Date): string {
  return date.toISOString();
}

export function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** Case-insensitive "contains" filter for a search term, matched as plain text (no wildcards). */
export function contains(term: string): { contains: string; mode: 'insensitive' } {
  return { contains: escapeLike(term), mode: 'insensitive' };
}

/** `{ archivedAt: null }` unless archived records were asked for. */
export function activeUnless(includeArchived: boolean): { archivedAt?: null } {
  return includeArchived ? {} : { archivedAt: null };
}

/** True for the database error raised by a unique constraint (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
