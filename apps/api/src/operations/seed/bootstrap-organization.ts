import type { INestApplicationContext } from '@nestjs/common';
import {
  createMembershipSchema,
  createUserSchema,
  DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS,
  localeSchema,
  timeZoneSchema,
} from '@ops/shared';
import { z } from 'zod';

import { ApiException } from '../../platform/http/api-exception';
import { checkNewPassword } from '../../platform/auth/password-policy';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { MembershipsService } from '../memberships/memberships.service';
import { toOrganizationFull } from '../organization/organization.service';
import { UsersService } from '../users/users.service';

/**
 * The real organization of a deployment and its first administrator, without any demo data
 * (`pnpm db:bootstrap`, for production). Everything else (sites, teams, log types, people) is
 * then set up by that administrator in the dashboard.
 */
export const bootstrapInputSchema = z.strictObject({
  organizationName: z.string().trim().min(1).max(200),
  /** The sign-in identifier the apps send (`*_PUBLIC_ORGANIZATION_SLUG`). */
  organizationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'lowercase letters, digits and hyphens'),
  timeZone: timeZoneSchema,
  locale: localeSchema.default('en'),
  adminName: z.string().trim().min(1).max(200),
  adminEmail: z.string().trim().toLowerCase().pipe(z.email()),
  /** Never printed, logged or stored as is. */
  adminPassword: z.string(),
});
export type BootstrapInput = z.input<typeof bootstrapInputSchema>;

export interface BootstrapResult {
  /** False when an organization with the slug exists already: nothing was changed. */
  created: boolean;
  organizationId: string;
  adminUserId: string | null;
}

/**
 * Creates the organization (audited) and its first administrator (org-wide admin membership),
 * through the real services under the system context. Idempotent: an existing slug changes
 * nothing. Works in every environment; the password goes only to
 * `AuthAdminService.setFirstPassword`, which applies the password policy.
 */
export async function bootstrapOrganization(
  app: INestApplicationContext,
  raw: BootstrapInput,
): Promise<BootstrapResult> {
  const input = bootstrapInputSchema.parse(raw);
  const prisma = app.get(PrismaService);
  const changes = app.get(ChangeRecorder);
  const access = app.get(AccessService);
  const users = app.get(UsersService);
  const memberships = app.get(MembershipsService);

  const existing = await prisma.organization.findUnique({
    where: { slug: input.organizationSlug },
  });
  if (existing) {
    return { created: false, organizationId: existing.id, adminUserId: null };
  }

  // The password policy is checked before anything is written, so a refused password leaves no
  // organization without an administrator behind. (setFirstPassword checks it again.)
  const problems = checkNewPassword(input.adminPassword, {
    email: input.adminEmail,
    displayName: input.adminName,
  });
  if (problems.length > 0) {
    throw ApiException.validation(problems, 'BOOTSTRAP_ADMIN_PASSWORD does not meet the policy');
  }

  // No endpoint creates organizations, so this one row is written directly (still audited).
  const organizationId = await prisma.$transaction(async (tx) => {
    const organization = toOrganizationFull(
      await tx.organization.create({
        data: {
          name: input.organizationName,
          slug: input.organizationSlug,
          settings: {
            timeZone: input.timeZone,
            locale: input.locale,
            workLogEditWindowHours: DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS,
          },
        },
      }),
    );
    await changes.record(tx, {
      organizationId: organization.id,
      entityType: 'organization',
      verb: 'created',
      entityId: organization.id,
      after: organization,
    });
    return organization.id;
  });

  const adminUserId = await access.runAsSystem(organizationId, async () => {
    const admin = await users.createWithFirstPassword(
      createUserSchema.parse({
        displayName: input.adminName,
        email: input.adminEmail,
        locale: input.locale,
      }),
      input.adminPassword,
    );
    await memberships.create(
      createMembershipSchema.parse({
        userId: admin.id,
        role: 'admin',
        orgWide: true,
        siteIds: [],
        teamIds: [],
      }),
    );
    return admin.id;
  });

  return { created: true, organizationId, adminUserId };
}
