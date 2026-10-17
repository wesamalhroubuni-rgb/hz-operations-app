import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { FILE_STORAGE, type FileStorage } from '../../platform/storage/file-storage';
import { STORAGE_SETTINGS, type StorageSettings } from '../../platform/storage/storage-settings';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { toAttachment } from './attachments.service';

/** A pending upload older than this is abandoned. */
export const STALE_UPLOAD_HOURS = 24;
/**
 * How long after `archivedAt + UPLOAD_URL_TTL_SECONDS` the purge of an archived pending upload is
 * still retried (each hourly run tries again, so a storage outage shorter than this is covered).
 */
export const PURGE_RETRY_HOURS = 48;
const RUN_EVERY_MS = 60 * 60 * 1000;
const BATCH_SIZE = 100;

/**
 * Removes abandoned uploads: attachments still `pending` more than {@link STALE_UPLOAD_HOURS}
 * after they were started. The object (if any bytes arrived) is deleted from the storage and the
 * attachment is archived with the event `attachment.upload_expired` (audit and outbox, actor
 * `system`). The row is kept, like every archived record.
 *
 * It also purges the stored upload of every attachment archived while still pending (by the
 * user, or by the expiry above) once its upload URL can no longer be used: an upload URL signed
 * before the archive stays valid for `UPLOAD_URL_TTL_SECONDS`, so bytes PUT after the archive
 * would otherwise stay in the storage forever. See {@link purgeArchivedPendingUploads}.
 *
 * Runs once an hour in each API process, the first time one hour after start-up (so the
 * integration tests, which never live that long, are not affected). Several API instances
 * running it at once is harmless: the archive only applies to a row that is still pending and
 * not archived.
 */
@Injectable()
export class AttachmentCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AttachmentCleanup');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings,
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
      const expired = await this.expireStaleUploads();
      if (expired > 0) {
        this.logger.log(`Expired ${expired} abandoned upload(s)`);
      }
      const purged = await this.purgeArchivedPendingUploads();
      if (purged > 0) {
        this.logger.log(`Purged the stored upload of ${purged} archived pending attachment(s)`);
      }
    } catch (error) {
      this.logger.warn(
        `Cleanup of abandoned uploads failed: ${error instanceof Error ? error.name : 'error'}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Expires the pending attachments started before `now - STALE_UPLOAD_HOURS`, in batches.
   * Returns how many were archived. Stops at the first storage failure (retried next run).
   */
  async expireStaleUploads(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_UPLOAD_HOURS * 60 * 60 * 1000);
    // Nothing is claimed while the storage is down, so the next run retries everything.
    await this.storage.assertAvailable();
    let expired = 0;
    for (;;) {
      const stale = await this.prisma.attachment.findMany({
        where: { status: 'pending', archivedAt: null, createdAt: { lt: cutoff } },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });
      for (const row of stale) {
        // Archive first (only if still pending), then delete the file. Deleting first would
        // destroy the file of an upload that a returning phone completes in between.
        const archived = await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.attachment.updateMany({
            where: { id: row.id, status: 'pending', archivedAt: null },
            data: { archivedAt: now },
          });
          if (count === 0) {
            return false;
          }
          const after = await tx.attachment.findUniqueOrThrow({ where: { id: row.id } });
          await this.changes.record(tx, {
            organizationId: row.organizationId,
            entityType: 'attachment',
            verb: 'upload_expired',
            entityId: row.id,
            before: toAttachment(row),
            after: toAttachment(after),
          });
          return true;
        });
        if (archived) {
          expired += 1;
          // A storage failure here stops the run; the row is already archived, so only the
          // bytes of an abandoned upload stay behind (harmless; a purge job can remove them).
          await this.storage.delete(row.storageKey);
        }
      }
      if (stale.length < BATCH_SIZE) {
        return expired;
      }
    }
  }

  /**
   * Deletes the upload object of every attachment archived while pending (`completedAt` null)
   * whose archive is older than the upload URL lifetime, so no valid URL can write it again.
   * Returns how many objects it asked the storage to delete.
   *
   * Idempotent without a "purged" mark (no schema change): deleting a missing object succeeds,
   * and only attachments archived in the last {@link PURGE_RETRY_HOURS} hours after that point
   * are looked at, so each one is retried by about 48 hourly runs and then left alone. Changes no
   * row, so nothing is audited. Stops at the first storage failure (retried next run).
   */
  async purgeArchivedPendingUploads(now: Date = new Date()): Promise<number> {
    const urlLifetimeMs = this.settings.uploadUrlTtlSeconds * 1000;
    const newest = new Date(now.getTime() - urlLifetimeMs);
    const oldest = new Date(newest.getTime() - PURGE_RETRY_HOURS * 60 * 60 * 1000);
    await this.storage.assertAvailable();
    let purged = 0;
    let afterId: string | undefined;
    for (;;) {
      const rows = await this.prisma.attachment.findMany({
        where: {
          status: 'pending',
          completedAt: null,
          archivedAt: { gte: oldest, lt: newest },
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        orderBy: { id: 'asc' },
        select: { id: true, storageKey: true },
        take: BATCH_SIZE,
      });
      for (const row of rows) {
        await this.storage.delete(row.storageKey);
        purged += 1;
      }
      if (rows.length < BATCH_SIZE) {
        return purged;
      }
      afterId = rows[rows.length - 1]?.id;
    }
  }
}
