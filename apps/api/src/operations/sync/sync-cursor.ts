import { createHash } from 'node:crypto';
import { SYNC_CURSOR_OVERLAP_SECONDS, syncCursorSchema } from '@ops/shared';
import { canonicalJson } from '../../platform/idempotency/idempotency';
import type { AccessContext } from '../access';

/**
 * The cursor of `GET /sync/pull` (ADR-0008 section 6): base64url JSON
 * `{ v: 1, t: <server time of the pull>, s: <scope fingerprint> }`. Opaque to the client.
 */
export const SYNC_CURSOR_VERSION = 1;

interface CursorPayload {
  v: number;
  t: string;
  s: string;
}

/**
 * A short hash of who the caller is and what they may see: user, organization, roles, the
 * organization-wide flag, the site, team and people ids of the scope, and the places the caller
 * belongs to (`memberOf`, which decides a worker's sites and teams). When it changes,
 * records may have become visible without their `updatedAt` moving, so a delta would miss them:
 * the next pull is a full one.
 */
export function scopeFingerprint(context: AccessContext): string {
  const { scope } = context;
  const sorted = (ids: readonly string[]) => [...ids].sort();
  return createHash('sha256')
    .update(
      canonicalJson({
        userId: context.userId,
        organizationId: context.organizationId,
        active: scope.active,
        roles: sorted(context.roles),
        orgWide: scope.orgWide,
        siteIds: sorted(scope.siteIds),
        teamIds: sorted(scope.teamIds),
        userIds: scope.userIds === 'all' ? 'all' : sorted(scope.userIds),
        memberOf: {
          orgWide: scope.memberOf.orgWide,
          siteIds: sorted(scope.memberOf.siteIds),
          teamIds: sorted(scope.memberOf.teamIds),
        },
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

export function encodeSyncCursor(serverTime: Date, fingerprint: string): string {
  const payload: CursorPayload = {
    v: SYNC_CURSOR_VERSION,
    t: serverTime.toISOString(),
    s: fingerprint,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * The time a cursor was taken, or null when it cannot be used for a delta: unreadable, another
 * version, another scope, or a time after `now` (a cursor from the future would hide changes).
 * Never throws: an unusable cursor means a full pull.
 */
export function decodeSyncCursor(
  cursor: string | undefined,
  fingerprint: string,
  now: Date,
): Date | null {
  if (!cursor || !syncCursorSchema.safeParse(cursor).success) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }
    const { v, t, s } = payload as Partial<CursorPayload>;
    if (v !== SYNC_CURSOR_VERSION || s !== fingerprint || typeof t !== 'string') {
      return null;
    }
    const time = new Date(t);
    if (Number.isNaN(time.getTime()) || time.getTime() > now.getTime()) {
      return null;
    }
    return time;
  } catch {
    return null;
  }
}

/** Where a delta starts: the cursor's time minus the safety overlap. */
export function changedSince(cursorTime: Date): Date {
  return new Date(cursorTime.getTime() - SYNC_CURSOR_OVERLAP_SECONDS * 1000);
}
