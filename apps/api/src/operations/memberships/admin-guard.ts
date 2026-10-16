import { canRemoveAdmin, enforce, type AdminHolder } from '../access';
import type { Db } from '../common/db';

/**
 * Refuses (409) a change that would leave the organization without an active admin. Call it
 * inside the transaction of the change, BEFORE writing, with what the change takes away: one
 * admin membership (archived or demoted) and/or every membership of one user (archived).
 *
 * The decision is the pure rule `canRemoveAdmin`; this only loads its input. It first takes a
 * transaction-scoped advisory lock per organization, so two such changes cannot both read
 * "there is another admin" and then remove each other.
 */
export async function assertAdminRemains(
  tx: Db,
  organizationId: string,
  removal: { membershipId?: string; userId?: string },
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`admins:${organizationId}`}))`;
  const holders: AdminHolder[] = (
    await tx.membership.findMany({
      where: { organizationId, role: 'admin', archivedAt: null, user: { archivedAt: null } },
      select: { id: true, userId: true },
    })
  ).map((membership) => ({ membershipId: membership.id, userId: membership.userId }));
  enforce(canRemoveAdmin(holders, removal), 'Membership');
}
