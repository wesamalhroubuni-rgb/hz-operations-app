import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  AI_DAY_RANGE_MAX_DAYS,
  AI_SUMMARY_GENERATE_MAX_DAYS_BACK,
  addDays,
  aiSettingsOf,
  localeOf,
  timeZoneOf,
  zonedDayKey,
  type DailySummary,
  type DailySummaryScope,
  type DailySummaryStats,
  type GenerateDailySummaries,
  type GenerateDailySummariesResult,
  type ListDailySummariesQuery,
  type Paginated,
  type Role,
} from '@ops/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { ApiException } from '../../../platform/http';
import { RequestContext } from '../../../platform/request-context/request-context';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessClock, AccessService } from '../../access';
import { ChangeRecorder } from '../../common/change-recorder';
import { iso, isUniqueViolation } from '../../common/db';
import { AnomaliesService } from '../anomalies/anomalies.service';
import { dayColumn, dayKeyOfColumn, daysBetween, inclusiveDayRange } from '../day-column';
import { SummaryNarrativeService } from './summary-narrative.service';
import { dueSummaryDay } from './summary-schedule';
import { SummaryStatsService } from './summary-stats.service';

type DailySummaryRow = Prisma.DailySummaryGetPayload<object>;

/** A stored summary in its wire shape (`dailySummarySchema`). */
export function dailySummaryToWire(row: DailySummaryRow): DailySummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    recipientId: row.recipientId,
    day: dayKeyOfColumn(row.day),
    timeZone: row.timeZone,
    scope: row.scope as unknown as DailySummaryScope,
    stats: row.stats as unknown as DailySummaryStats,
    anomalies: row.anomalies as unknown as DailySummary['anomalies'],
    narrative: row.narrative,
    narrativeSource: row.narrativeSource,
    locale: localeOf(row.locale),
    createdAt: iso(row.createdAt),
  };
}

interface Recipient {
  id: string;
  locale: string;
}

interface GenerateOptions {
  /** Only this recipient (who must be one by the organization's settings). */
  recipientId?: string | undefined;
  /** The admin who asked (`POST /ai/summaries/generate`); recorded in the audit metadata. */
  requestedById?: string | null;
}

type OneResult = { status: 'generated'; id: string } | { status: 'skipped' };

/**
 * Daily summaries (Phase 7, ADR-0011): generation for an organization and day, and the reads.
 *
 * Generation runs WITHOUT a signed-in user (the scheduler; the admin route detaches from its
 * caller first): the flags of the day are computed under `runAsSystem`, each recipient's facts
 * under `runAsUser` (their own, freshly resolved scope), and each summary is written in one
 * transaction with its audit and outbox event. Idempotent per (recipient, day): an existing
 * summary is skipped, and a race lost on the unique key is a skip too.
 */
@Injectable()
export class SummariesService {
  private readonly logger = new Logger('DailySummaries');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly changes: ChangeRecorder,
    private readonly clock: AccessClock,
    private readonly anomalies: AnomaliesService,
    private readonly stats: SummaryStatsService,
    private readonly narratives: SummaryNarrativeService,
  ) {}

  /**
   * Generates the missing summaries of `day` (org-local) for the organization's recipients, or
   * for one. Nothing at all while `dailySummaryEnabled` is off. Must run outside a signed-in
   * request (it acts as the system and reads as each recipient).
   */
  async generateForDay(
    organizationId: string,
    day: string,
    options: GenerateOptions = {},
  ): Promise<GenerateDailySummariesResult> {
    const result: GenerateDailySummariesResult = {
      day,
      generated: 0,
      skipped: 0,
      failed: 0,
      summaryIds: [],
    };
    const organization = await this.prisma.organization.findFirst({
      where: { id: organizationId, archivedAt: null },
      select: { settings: true },
    });
    if (!organization) {
      return result;
    }
    const settings = aiSettingsOf(organization.settings);
    if (!settings.dailySummaryEnabled) {
      return result;
    }
    const timeZone = timeZoneOf(organization.settings);
    const recipients = await this.recipients(
      organizationId,
      settings.summaryRecipientRoles,
      options.recipientId,
    );
    const existing = await this.prisma.dailySummary.findMany({
      where: {
        organizationId,
        day: dayColumn(day),
        recipientId: { in: recipients.map((recipient) => recipient.id) },
      },
      select: { recipientId: true },
    });
    const done = new Set(existing.map((row) => row.recipientId));
    result.skipped = done.size;
    const pending = recipients.filter((recipient) => !done.has(recipient.id));
    if (pending.length === 0) {
      return result;
    }

    // The flags first (all data, once per organization and day), then each recipient's view.
    await this.anomalies.computeForDay(organizationId, day, timeZone);

    for (const recipient of pending) {
      try {
        const one = await this.generateOne(organizationId, recipient, day, timeZone, options);
        if (one.status === 'generated') {
          result.generated += 1;
          result.summaryIds.push(one.id);
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        if (error instanceof ApiException && error.code === 'unauthenticated') {
          // The recipient lost access since the run started: no summary for them.
          result.skipped += 1;
          continue;
        }
        result.failed += 1;
        this.logger.error(
          `Daily summary of recipient ${recipient.id} on ${day} failed: ` +
            (error instanceof Error ? error.name : 'unknown error'),
        );
      }
    }
    if (result.generated > 0) {
      this.logger.log(
        `${result.generated} daily summar${result.generated === 1 ? 'y' : 'ies'} for ` +
          `organization ${organizationId} on ${day}`,
      );
    }
    return result;
  }

  /**
   * Active users with an active membership in one of the recipient roles. Workers never receive
   * a summary, whatever the settings say.
   */
  private recipients(
    organizationId: string,
    roles: readonly Role[],
    recipientId?: string,
  ): Promise<Recipient[]> {
    const allowed = roles.filter((role) => role !== 'worker');
    if (allowed.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.user.findMany({
      where: {
        organizationId,
        archivedAt: null,
        memberships: { some: { archivedAt: null, role: { in: allowed } } },
        ...(recipientId ? { id: recipientId } : {}),
      },
      select: { id: true, locale: true },
      orderBy: { id: 'asc' },
    });
  }

  private async generateOne(
    organizationId: string,
    recipient: Recipient,
    day: string,
    timeZone: string,
    options: GenerateOptions,
  ): Promise<OneResult> {
    const now = this.clock.now();
    const data = await this.access.runAsUser(organizationId, recipient.id, async () =>
      this.stats.compute(await this.access.context(), day, timeZone, now),
    );
    const locale = localeOf(recipient.locale);
    const written = await this.narratives.write(organizationId, recipient.id, data, locale);
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const row = await tx.dailySummary.create({
          data: {
            organizationId,
            recipientId: recipient.id,
            day: dayColumn(day),
            timeZone,
            scope: data.scope as unknown as Prisma.InputJsonValue,
            stats: data.stats as unknown as Prisma.InputJsonValue,
            anomalies: data.anomalies as unknown as Prisma.InputJsonValue,
            narrative: written.narrative,
            narrativeSource: written.source,
            locale,
            traceIds: written.traceIds,
          },
        });
        // Ids, day, source and counts only: never the narrative (the audit log keeps it forever).
        await this.changes.record(tx, {
          organizationId,
          entityType: 'daily_summary',
          verb: 'created',
          entityId: row.id,
          after: {
            id: row.id,
            organizationId,
            recipientId: recipient.id,
            day,
            narrativeSource: written.source,
            locale,
            traceIds: written.traceIds,
            counts: {
              logs: data.stats.logs.total,
              tasksOpen: data.stats.tasks.open,
              tasksOverdue: data.stats.tasks.overdue,
              anomalies: data.stats.anomalies.total,
            },
          },
          ...(options.requestedById
            ? { auditMetadata: { requestedById: options.requestedById } }
            : {}),
        });
        return row.id;
      });
      return { status: 'generated', id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { status: 'skipped' };
      }
      throw error;
    }
  }

  /**
   * `POST /ai/summaries/generate` (admins): one recent day now, for every recipient or one. The
   * work runs detached from the admin's request (a context without an acting user, same
   * correlation id), because it acts as the system and reads as each recipient; the admin is
   * recorded as `requestedById` in the audit metadata.
   */
  async generateNow(input: GenerateDailySummaries): Promise<GenerateDailySummariesResult> {
    const context = await this.access.context();
    const { organizationId } = context;
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = aiSettingsOf(organization.settings);
    if (!settings.dailySummaryEnabled) {
      throw ApiException.of(
        'ai_disabled',
        'Daily summaries are switched off for this organization',
      );
    }
    const now = this.clock.now();
    const timeZone = timeZoneOf(organization.settings);
    const today = zonedDayKey(now, timeZone);
    // The last day whose summaries are due: today once the summary time has passed, else
    // yesterday. Today's summaries written early would be partial, and the scheduled run would
    // skip them at the summary time (idempotent per recipient and day).
    const lastDue = dueSummaryDay(now, timeZone, settings.summaryTime) ?? addDays(today, -1);
    const day = input.day ?? lastDue;
    if (day > today) {
      throw ApiException.unprocessable('A summary cannot be generated for a future day', [
        { path: 'day', message: 'must not be after today' },
      ]);
    }
    if (day > lastDue) {
      throw ApiException.unprocessable(
        `Today's summaries can be generated only after the summary time (${settings.summaryTime})`,
        [{ path: 'day', message: `must not be today before ${settings.summaryTime}` }],
      );
    }
    if (daysBetween(day, today) > AI_SUMMARY_GENERATE_MAX_DAYS_BACK) {
      throw ApiException.unprocessable(
        `Summaries can be generated for at most ${AI_SUMMARY_GENERATE_MAX_DAYS_BACK} days back`,
        [{ path: 'day', message: `must be at most ${AI_SUMMARY_GENERATE_MAX_DAYS_BACK} days ago` }],
      );
    }
    if (input.recipientId) {
      const recipients = await this.recipients(
        organizationId,
        settings.summaryRecipientRoles,
        input.recipientId,
      );
      if (recipients.length === 0) {
        throw ApiException.unprocessable('This user does not receive daily summaries', [
          {
            path: 'recipientId',
            message: 'must be an active user with one of the recipient roles',
          },
        ]);
      }
    }
    const store = { correlationId: RequestContext.correlationId() ?? randomUUID(), actor: null };
    return RequestContext.run(store, () =>
      this.generateForDay(organizationId, day, {
        recipientId: input.recipientId,
        requestedById: context.userId,
      }),
    );
  }

  /** `GET /ai/summaries`: the caller's own summaries, newest day first. */
  async list(query: ListDailySummariesQuery): Promise<Paginated<DailySummary>> {
    const context = await this.access.context();
    let dayFilter: Prisma.DailySummaryWhereInput = {};
    if (query.from && query.to) {
      const range = inclusiveDayRange(query, query.to, AI_DAY_RANGE_MAX_DAYS);
      dayFilter = { day: { gte: dayColumn(range.from), lte: dayColumn(range.to) } };
    } else if (query.from) {
      dayFilter = { day: { gte: dayColumn(query.from) } };
    } else if (query.to) {
      dayFilter = { day: { lte: dayColumn(query.to) } };
    }
    const where: Prisma.DailySummaryWhereInput = {
      organizationId: context.organizationId,
      recipientId: context.userId,
      ...dayFilter,
    };
    const [total, rows] = await Promise.all([
      this.prisma.dailySummary.count({ where }),
      this.prisma.dailySummary.findMany({
        where,
        orderBy: [{ day: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map(dailySummaryToWire),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /** `GET /ai/summaries/:id`: one of the caller's own summaries; anyone else's is 404. */
  async get(id: string): Promise<DailySummary> {
    const context = await this.access.context();
    const row = await this.prisma.dailySummary.findFirst({
      where: { id, organizationId: context.organizationId, recipientId: context.userId },
    });
    if (!row) {
      throw ApiException.notFound('Daily summary', id);
    }
    return dailySummaryToWire(row);
  }
}
