import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  AI_CAPTURE_DECIDED_INPUT_RETENTION_DAYS,
  AI_CAPTURE_INPUT_RETENTION_DAYS,
} from '@ops/shared';
import { Prisma } from '../../../generated/prisma/client';
import { AiTraceService } from '../../../platform/ai';
import { FILE_STORAGE, type FileStorage } from '../../../platform/storage/file-storage';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChangeRecorder } from '../../common/change-recorder';
import { captureRecordOf } from './smart-capture.mapper';

/** A capture's transcript, proposal and confidence are cleared this many days after creation. */
export const AI_CAPTURE_CONTENT_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;
const RUN_EVERY_MS = 60 * 60 * 1000;
const BATCH_SIZE = 100;

export interface CaptureRetentionResult {
  inputsPurged: number;
  contentsCleared: number;
  traceOutputsCleared: number;
  tracesDeleted: number;
}

/**
 * Retention of smart captures and AI traces (ADR-0010 section 3), once an hour in each API
 * process, the first time one hour after start-up (the integration tests never live that long
 * and call {@link run} directly), like the attachment clean-up:
 *
 * - the input bytes (audio, photo) of a capture are deleted from the storage 30 days after it
 *   was created, or 7 days after it was confirmed or discarded, whichever comes first
 *   (`inputPurgedAt` set; event `smart_capture.input_purged`);
 * - its transcript, proposal and confidence are cleared 90 days after creation (the confirmed
 *   work log keeps its own content; event `smart_capture.content_cleared`);
 * - `AiTraceService.purgeExpired`: trace outputs cleared after 90 days, rows deleted after 400.
 *
 * Idempotent and safe with several instances: each change applies only to a row still matching
 * its condition. A storage failure stops the input purge (retried next run) but not the rest.
 */
@Injectable()
export class CaptureRetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CaptureRetention');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly traces: AiTraceService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.runSafely(), RUN_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runSafely(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.run(new Date());
      if (Object.values(result).some((count) => count > 0)) {
        this.logger.log(
          `Retention: ${result.inputsPurged} capture input(s) purged, ` +
            `${result.contentsCleared} capture content(s) cleared, ` +
            `${result.traceOutputsCleared} trace output(s) cleared, ` +
            `${result.tracesDeleted} trace(s) deleted`,
        );
      }
    } catch (error) {
      this.logger.warn(`Retention run failed: ${error instanceof Error ? error.name : 'error'}`);
    } finally {
      this.running = false;
    }
  }

  async run(now: Date): Promise<CaptureRetentionResult> {
    let inputsPurged = 0;
    try {
      inputsPurged = await this.purgeInputs(now);
    } catch (error) {
      this.logger.warn(
        `Purge of capture inputs stopped: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
    const contentsCleared = await this.clearContents(now);
    const traces = await this.traces.purgeExpired(now);
    return {
      inputsPurged,
      contentsCleared,
      traceOutputsCleared: traces.outputsCleared,
      tracesDeleted: traces.deleted,
    };
  }

  /** Deletes the input bytes that are due. Stops at the first storage failure. */
  async purgeInputs(now: Date): Promise<number> {
    const createdBefore = new Date(now.getTime() - AI_CAPTURE_INPUT_RETENTION_DAYS * DAY_MS);
    const decidedBefore = new Date(
      now.getTime() - AI_CAPTURE_DECIDED_INPUT_RETENTION_DAYS * DAY_MS,
    );
    const due: Prisma.SmartCaptureWhereInput = {
      inputStorageKey: { not: null },
      inputPurgedAt: null,
      OR: [
        { createdAt: { lt: createdBefore } },
        { status: { in: ['confirmed', 'discarded'] }, decidedAt: { lt: decidedBefore } },
      ],
    };
    let purged = 0;
    for (;;) {
      const rows = await this.prisma.smartCapture.findMany({
        where: due,
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      });
      for (const row of rows) {
        // The bytes first: a crash in between leaves the row to be purged again (deleting a
        // missing object succeeds).
        await this.storage.delete(row.inputStorageKey!);
        await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.smartCapture.updateMany({
            where: { id: row.id, inputPurgedAt: null },
            data: { inputPurgedAt: now },
          });
          if (count === 0) {
            return;
          }
          const after = await tx.smartCapture.findUniqueOrThrow({ where: { id: row.id } });
          await this.changes.record(tx, {
            organizationId: row.organizationId,
            entityType: 'smart_capture',
            verb: 'input_purged',
            entityId: row.id,
            before: captureRecordOf(row),
            after: captureRecordOf(after),
          });
        });
        purged += 1;
      }
      if (rows.length < BATCH_SIZE) {
        return purged;
      }
    }
  }

  /** Clears transcript, proposal and confidence of captures older than 90 days. */
  async clearContents(now: Date): Promise<number> {
    const createdBefore = new Date(now.getTime() - AI_CAPTURE_CONTENT_RETENTION_DAYS * DAY_MS);
    const due: Prisma.SmartCaptureWhereInput = {
      createdAt: { lt: createdBefore },
      OR: [
        { transcript: { not: null } },
        { proposal: { not: Prisma.DbNull } },
        { confidence: { not: Prisma.DbNull } },
      ],
    };
    let cleared = 0;
    for (;;) {
      const rows = await this.prisma.smartCapture.findMany({
        where: due,
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      });
      for (const row of rows) {
        await this.prisma.$transaction(async (tx) => {
          const after = await tx.smartCapture.update({
            where: { id: row.id },
            data: { transcript: null, proposal: Prisma.DbNull, confidence: Prisma.DbNull },
          });
          await this.changes.record(tx, {
            organizationId: row.organizationId,
            entityType: 'smart_capture',
            verb: 'content_cleared',
            entityId: row.id,
            before: captureRecordOf(row),
            after: captureRecordOf(after),
          });
        });
        cleared += 1;
      }
      if (rows.length < BATCH_SIZE) {
        return cleared;
      }
    }
  }
}
