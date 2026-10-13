import { randomUUID } from 'node:crypto';
import type { CustomFieldDefinitionInput, Role } from '@ops/shared';
import type { Prisma } from '../../src/generated/prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Small factories that write test data straight through Prisma (no audit or outbox rows, so a
 * test starts from a known, empty log). Names are fictional; no real people or credentials.
 */

let counter = 0;

/** A number that is unique within the test run, for names, emails and slugs. */
function next(): number {
  counter += 1;
  return counter;
}

/** A fixed moment in the past, `minutes` after 2026-09-01T08:00:00Z. */
export function at(minutes = 0): Date {
  return new Date(Date.UTC(2026, 8, 1, 8, 0, 0) + minutes * 60_000);
}

/** A UUID that names no record. */
export function unknownId(): string {
  return randomUUID();
}

export function createOrganization(
  prisma: PrismaService,
  data: Partial<Prisma.OrganizationUncheckedCreateInput> = {},
) {
  const n = next();
  return prisma.organization.create({
    data: { name: `Test Org ${n}`, slug: `test-org-${n}`, ...data },
  });
}

export function createUser(
  prisma: PrismaService,
  organizationId: string,
  data: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  const n = next();
  return prisma.user.create({
    data: {
      organizationId,
      email: `user${n}@example.test`,
      displayName: `Test User ${n}`,
      ...data,
    },
  });
}

export function createSite(
  prisma: PrismaService,
  organizationId: string,
  data: Partial<Prisma.SiteUncheckedCreateInput> = {},
) {
  return prisma.site.create({ data: { organizationId, name: `Site ${next()}`, ...data } });
}

export function createTeam(
  prisma: PrismaService,
  organizationId: string,
  data: Partial<Prisma.TeamUncheckedCreateInput> = {},
) {
  return prisma.team.create({ data: { organizationId, name: `Team ${next()}`, ...data } });
}

export interface MembershipScope {
  orgWide?: boolean;
  siteIds?: string[];
  teamIds?: string[];
  archivedAt?: Date | null;
}

export function createMembership(
  prisma: PrismaService,
  organizationId: string,
  userId: string,
  role: Role,
  scope: MembershipScope = {},
) {
  return prisma.membership.create({
    data: {
      organizationId,
      userId,
      role,
      orgWide: scope.orgWide ?? false,
      archivedAt: scope.archivedAt ?? null,
      sites: { create: (scope.siteIds ?? []).map((siteId) => ({ siteId, organizationId })) },
      teams: { create: (scope.teamIds ?? []).map((teamId) => ({ teamId, organizationId })) },
    },
  });
}

/** The inspection log type used by most work-log tests. */
export const INSPECTION_FIELDS: CustomFieldDefinitionInput[] = [
  { key: 'area', label: 'Area', type: 'text', required: true },
  { key: 'quantity', label: 'Quantity', type: 'number', required: true },
  { key: 'passed', label: 'Passed', type: 'boolean' },
  { key: 'result', label: 'Result', type: 'select', options: ['ok', 'defect'] },
  { key: 'next_check', label: 'Next check', type: 'date' },
];

export function createLogType(
  prisma: PrismaService,
  organizationId: string,
  data: Partial<Omit<Prisma.LogTypeUncheckedCreateInput, 'fields'>> & {
    fields?: CustomFieldDefinitionInput[];
  } = {},
) {
  const n = next();
  const { fields, ...rest } = data;
  return prisma.logType.create({
    data: {
      organizationId,
      key: `log_type_${n}`,
      name: `Log type ${n}`,
      fields: (fields ?? INSPECTION_FIELDS).map((field) => ({ required: false, ...field })),
      ...rest,
    },
  });
}

export function createTask(
  prisma: PrismaService,
  organizationId: string,
  createdById: string,
  data: Partial<Omit<Prisma.TaskUncheckedCreateInput, 'assignees'>> & {
    assigneeIds?: string[];
  } = {},
) {
  const { assigneeIds, ...rest } = data;
  return prisma.task.create({
    data: {
      organizationId,
      createdById,
      title: `Task ${next()}`,
      assignees: { create: (assigneeIds ?? []).map((userId) => ({ userId, organizationId })) },
      ...rest,
    },
  });
}

export function createWorkLog(
  prisma: PrismaService,
  organizationId: string,
  authorId: string,
  data: Partial<Prisma.WorkLogUncheckedCreateInput> = {},
) {
  return prisma.workLog.create({
    data: {
      organizationId,
      authorId,
      clientId: randomUUID(),
      occurredAt: at(),
      text: `Work log ${next()}`,
      ...data,
    },
  });
}

export interface Tenant {
  organization: Awaited<ReturnType<typeof createOrganization>>;
  /** An active user holding an organization-wide admin membership. */
  admin: Awaited<ReturnType<typeof createUser>>;
}

/** One organization with one admin to act as. */
export async function createTenant(prisma: PrismaService, name?: string): Promise<Tenant> {
  const organization = await createOrganization(prisma, name ? { name } : {});
  const admin = await createUser(prisma, organization.id, { displayName: 'Admin' });
  await createMembership(prisma, organization.id, admin.id, 'admin', { orgWide: true });
  return { organization, admin };
}

/** How many audit and outbox rows exist, optionally for one organization. */
export async function eventCounts(
  prisma: PrismaService,
  organizationId?: string,
): Promise<{ audit: number; outbox: number }> {
  const where = organizationId ? { organizationId } : {};
  const [audit, outbox] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.outboxEvent.count({ where }),
  ]);
  return { audit, outbox };
}
