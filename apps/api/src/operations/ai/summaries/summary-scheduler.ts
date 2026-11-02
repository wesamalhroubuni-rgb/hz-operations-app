import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { aiSettingsOf, timeZoneOf } from '@ops/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessClock } from '../../access';
import { dueSummaryDay } from './summary-schedule';
import { SummariesService } from './summaries.service';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * After a failed pass of an (organization, day), the scheduler leaves it alone this long instead
 * of retrying at every wake-up (in memory, per process).
 */
export const SUMMARY_RETRY_BACKOFF_MS = 15 * 60_000;

export interface SchedulerRun {
  /** Organizations whose summaries were due and looked at. */
  organizations: number;
  generated: number;
  failed: number;
}

/**
 * Wakes every `AI_SUMMARY_POLL_INTERVAL_MS` while `AI_SUMMARY_SCHEDULER_ENABLED` is true (Phase 7,
 * ADR-0011 section 1) and, for each active organization with daily summaries on whose local time
 * has passed its `summaryTime`, generates the summaries of that local day that do not exist yet.
 * A `setTimeout` chain, so runs never overlap in one process; several processes may race, and
 * the unique (recipient, day) key decides. Off unless configured (the tests drive `runOnce`).
 */
@Injectable()
export class SummaryScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SummaryScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SchedulerRun> | null = null;
  private stopped = true;
  /** `<organizationId>:<day>` -> the earliest retry time (epoch ms) after a failed pass. */
  private readonly retryAfter = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly summaries: SummariesService,
    private readonly clock: AccessClock,
  ) {}

  private get enabled(): boolean {
    return this.config.get<boolean>('AI_SUMMARY_SCHEDULER_ENABLED') === true;
  }

  private get intervalMs(): number {
    const value = this.config.get<number>('AI_SUMMARY_POLL_INTERVAL_MS');
    return typeof value === 'number' && value > 0 ? value : DEFAULT_POLL_INTERVAL_MS;
  }

  onApplicationBootstrap(): void {
    if (this.enabled) {
      this.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.logger.log(`Daily summary scheduler started (every ${this.intervalMs} ms)`);
    this.schedule(this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running.catch(() => undefined);
    }
  }

  /**
   * One pass at `now`: every due organization, one after the other. A failing organization is
   * logged and retried at the first wake-up {@link SUMMARY_RETRY_BACKOFF_MS} later (a pass that
   * threw, or left recipients unwritten); the others go on. A call while a pass is running
   * waits for that pass.
   */
  runOnce(now: Date = this.clock.now()): Promise<SchedulerRun> {
    if (this.running) {
      return this.running;
    }
    this.running = this.pass(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(now: Date): Promise<SchedulerRun> {
    const run: SchedulerRun = { organizations: 0, generated: 0, failed: 0 };
    for (const [key, retryAt] of this.retryAfter) {
      if (retryAt <= now.getTime()) {
        this.retryAfter.delete(key);
      }
    }
    const organizations = await this.prisma.organization.findMany({
      where: { archivedAt: null },
      select: { id: true, settings: true },
      orderBy: { id: 'asc' },
    });
    for (const organization of organizations) {
      const settings = aiSettingsOf(organization.settings);
      if (!settings.dailySummaryEnabled) {
        continue;
      }
      const day = dueSummaryDay(now, timeZoneOf(organization.settings), settings.summaryTime);
      if (!day) {
        continue;
      }
      const key = `${organization.id}:${day}`;
      if (this.retryAfter.has(key)) {
        continue;
      }
      run.organizations += 1;
      try {
        const result = await this.summaries.generateForDay(organization.id, day);
        run.generated += result.generated;
        run.failed += result.failed;
        if (result.failed > 0) {
          this.retryAfter.set(key, now.getTime() + SUMMARY_RETRY_BACKOFF_MS);
        }
      } catch (error) {
        run.failed += 1;
        this.retryAfter.set(key, now.getTime() + SUMMARY_RETRY_BACKOFF_MS);
        this.logger.warn(
          `Daily summaries of organization ${organization.id} on ${day} failed: ` +
            (error instanceof Error ? error.name : 'unknown error'),
        );
      }
    }
    return run;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.warn(
        `Daily summary pass failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    this.schedule(this.intervalMs);
  }
}
