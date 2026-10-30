import { timeZoneOf } from '@ops/shared';
import type { Db } from './db';

/**
 * The organization's time zone (`settings.timeZone`, ADR-0009), or the default when it has not
 * set one or the stored value is unusable.
 */
export async function loadTimeZone(db: Db, organizationId: string): Promise<string> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  return timeZoneOf(organization?.settings);
}
