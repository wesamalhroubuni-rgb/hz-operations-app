import type { ListWorkLogsQuery } from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { workLogVisibilityWhere, type AccessContext } from '../access';
import { activeUnless, contains } from '../common/db';

/**
 * The filters the work-log list, the map, the CSV export and the report share
 * (`workLogFilterShape` in @ops/shared, ADR-0009). Every key is optional here so each caller
 * passes only what its query has.
 */
export type WorkLogFilters = Partial<Omit<ListWorkLogsQuery, 'page' | 'pageSize' | 'sort'>>;

/** Photos that count: uploaded, verified and not archived. */
export const READY_ATTACHMENTS: Prisma.AttachmentWhereInput = { status: 'ready', archivedAt: null };

/** `_count` of the ready photos of each log, in the same query as the logs. */
export const ATTACHMENT_COUNT = {
  _count: { select: { attachments: { where: READY_ATTACHMENTS } } },
} satisfies Prisma.WorkLogInclude;

/**
 * The one `where` of every work-log read of the dashboard: the caller's organization, the
 * caller's visibility (under `AND`, so the filters can only narrow it), and the filters asked
 * for. Archived logs are left out unless `includeArchived` is true.
 */
export function workLogWhere(
  context: AccessContext,
  filters: WorkLogFilters,
  extra: Prisma.WorkLogWhereInput[] = [],
): Prisma.WorkLogWhereInput {
  const and: Prisma.WorkLogWhereInput[] = [
    workLogVisibilityWhere(context) as Prisma.WorkLogWhereInput,
    ...extra,
  ];
  if (filters.search) {
    and.push({ text: contains(filters.search) });
  }
  if (filters.excludeOwn) {
    and.push({ authorId: { not: context.userId } });
  }
  if (filters.hasPhotos !== undefined) {
    and.push(
      filters.hasPhotos
        ? { attachments: { some: READY_ATTACHMENTS } }
        : { attachments: { none: READY_ATTACHMENTS } },
    );
  }
  return {
    organizationId: context.organizationId,
    ...activeUnless(filters.includeArchived ?? false),
    AND: and,
    ...(filters.authorId ? { authorId: filters.authorId } : {}),
    ...(filters.siteId ? { siteId: filters.siteId } : {}),
    ...(filters.teamId ? { teamId: filters.teamId } : {}),
    ...(filters.taskId ? { taskId: filters.taskId } : {}),
    ...(filters.logTypeId ? { logTypeId: filters.logTypeId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.occurredFrom || filters.occurredTo
      ? {
          occurredAt: {
            ...(filters.occurredFrom ? { gte: new Date(filters.occurredFrom) } : {}),
            ...(filters.occurredTo ? { lt: new Date(filters.occurredTo) } : {}),
          },
        }
      : {}),
  };
}

/** The first `length` characters of a log's text (an ellipsis when cut), or null. */
export function excerptOf(text: string | null, length: number): string | null {
  if (text === null) {
    return null;
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) {
    return null;
  }
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}
