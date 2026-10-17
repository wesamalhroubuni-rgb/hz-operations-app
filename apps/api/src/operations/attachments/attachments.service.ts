import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type {
  Attachment,
  AttachmentMimeType,
  AttachmentUpload,
  ListAttachmentsQuery,
  Paginated,
  StartAttachmentUpload,
} from '@ops/shared';
import type {
  Attachment as AttachmentRow,
  Prisma,
  WorkLog as WorkLogRow,
} from '../../generated/prisma/client';
import {
  RATE_LIMITER,
  type RateLimiter,
  type RateLimitRule,
} from '../../platform/auth/rate-limiter';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { ConcurrencyLimitTimeoutError, KeyedSerializer } from '../../platform/storage/concurrency';
import {
  FILE_STORAGE,
  StorageUnavailableError,
  StoredFileTooLargeError,
  type FileStorage,
  type UploadTarget,
} from '../../platform/storage/file-storage';
import {
  ImageProcessor,
  THUMBNAIL_MIME_TYPE,
  type ImageCheck,
} from '../../platform/storage/images';
import { STORAGE_SETTINGS, type StorageSettings } from '../../platform/storage/storage-settings';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessClock,
  AccessService,
  attachmentVisibilityWhere,
  authorOf,
  canChangeAttachments,
  enforce,
  MAX_ATTACHMENTS_PER_WORK_LOG,
  workLogVisibilityWhere,
  type AccessContext,
} from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, iso, isoOrNull, type Db } from '../common/db';
import { loadWorkLogEditWindowHours, workLogFactsOf } from '../work-logs/work-logs.service';

const EXTENSIONS: Record<AttachmentMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * The storage key of a new attachment, chosen by the API alone. Nothing from the client (file
 * name, ...) goes into it: `org/<organizationId>/work-logs/<workLogId>/<random uuid>.<jpg|png>`.
 */
export function attachmentStorageKey(
  organizationId: string,
  workLogId: string,
  mimeType: AttachmentMimeType,
): string {
  return `org/${organizationId}/work-logs/${workLogId}/${randomUUID()}.${EXTENSIONS[mimeType]}`;
}

/**
 * Key of the re-encoded original of an upload:
 * `<upload key without extension>.<nonce>.verified.<ext>`. Only the API writes it and no upload
 * URL is ever signed for it, so an upload URL that is still valid after `complete` cannot replace
 * what is served. The nonce keeps two racing completions (two API instances) apart.
 */
export function verifiedKeyOf(uploadKey: string, nonce: string = randomUUID().slice(0, 8)): string {
  const dot = uploadKey.lastIndexOf('.');
  return `${uploadKey.slice(0, dot)}.${nonce}.verified${uploadKey.slice(dot)}`;
}

/**
 * Per-user limits on the upload steps (in process memory, through the platform `RATE_LIMITER`,
 * like the sign-in limits). A worker adds a few photos per log, at most 20; these only stop a
 * script or a client stuck in a loop. Constants on purpose: no deployment has needed to tune them.
 */
export const UPLOAD_RATE_LIMITS = {
  start: { limit: 60, windowSeconds: 600 },
  complete: { limit: 60, windowSeconds: 600 },
  renew: { limit: 60, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;

/** Key of the thumbnail of an attachment: next to the (verified) original. */
export function thumbnailKeyOf(storageKey: string): string {
  return `${storageKey}.thumb.jpg`;
}

/** Signed download URLs of a ready attachment, or nulls. */
export interface AttachmentUrls {
  url: string | null;
  thumbnailUrl: string | null;
  urlsExpireAt: string | null;
}

const NO_URLS: AttachmentUrls = { url: null, thumbnailUrl: null, urlsExpireAt: null };

/**
 * The attachment as sent to a caller who may see it. The storage keys are never sent; the URLs
 * are signed by the caller of this function, only for callers who may see the parent work log.
 */
export function toAttachment(row: AttachmentRow, urls: AttachmentUrls = NO_URLS): Attachment {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workLogId: row.workLogId,
    uploadedById: row.uploadedById,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    width: row.width,
    height: row.height,
    ...urls,
    createdAt: iso(row.createdAt),
    completedAt: isoOrNull(row.completedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

/** The same without URLs: what the audit log and the outbox record. */
function recordOf(row: AttachmentRow): Attachment {
  return toAttachment(row);
}

const REJECTION_MESSAGES: Record<Exclude<ImageCheck, { ok: true }>['reason'], string> = {
  not_an_image: 'The uploaded file is not a JPEG or PNG image',
  type_mismatch: 'The uploaded file does not match the declared image type',
  corrupt: 'The uploaded image is damaged or incomplete and cannot be read',
  too_many_pixels: 'The uploaded image has too many pixels',
};

/**
 * Photos on work logs, uploaded straight to the file storage:
 *
 * 1. `startUpload` checks the caller may change the log's attachments, creates a `pending`
 *    attachment with a key the API chooses, and returns a pre-signed PUT target;
 * 2. the client PUTs the bytes to the storage;
 * 3. `complete` reads the object back, verifies by content that it is the declared image type,
 *    stores its dimensions and a thumbnail, and marks it `ready`.
 *
 * Attachments follow their work log (see attachment.rules.ts). Signed URLs are only ever
 * computed for attachments loaded through `attachmentVisibilityWhere`.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger('Attachments');
  /** Completions of the same attachment run one after the other in this process. */
  private readonly completions = new KeyedSerializer();

  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
    private readonly clock: AccessClock,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    private readonly images: ImageProcessor,
  ) {}

  async listForWorkLog(
    workLogId: string,
    query: ListAttachmentsQuery,
  ): Promise<Paginated<Attachment>> {
    const context = await this.access.context();
    await this.findWorkLog(this.prisma, context, workLogId);
    const where: Prisma.AttachmentWhereInput = {
      organizationId: context.organizationId,
      workLogId,
      ...activeUnless(query.includeArchived),
      AND: [attachmentVisibilityWhere(context) as Prisma.AttachmentWhereInput],
    };
    const [rows, total] = await Promise.all([
      this.prisma.attachment.findMany({
        where,
        orderBy: orderByArgs(query.sort),
        ...pageArgs(query),
      }),
      this.prisma.attachment.count({ where }),
    ]);
    return paginated(await Promise.all(rows.map((row) => this.present(row))), total, query);
  }

  async get(id: string): Promise<Attachment> {
    const context = await this.access.context();
    return this.present((await this.find(this.prisma, context, id)).attachment);
  }

  /**
   * Step 1: creates a pending attachment on a work log and returns where to PUT the bytes. The
   * uploader is the signed-in user; the storage key is chosen here.
   */
  async startUpload(workLogId: string, input: StartAttachmentUpload): Promise<AttachmentUpload> {
    const context = await this.access.context();
    await this.limit('start', context);
    const { organizationId } = context;
    const uploadedById = authorOf(context);
    const maxBytes = this.settings.uploadMaxBytes;
    if (input.sizeBytes > maxBytes) {
      throw ApiException.validation(
        [{ path: 'sizeBytes', message: `must be at most ${maxBytes} bytes` }],
        `The file is too large: the limit is ${maxBytes} bytes`,
      );
    }
    // Nothing is created while the storage is down: the client gets 503 and retries.
    await this.storageCall(() => this.storage.assertAvailable());
    const row = await this.prisma.$transaction(async (tx) => {
      const workLog = await this.findWorkLog(tx, context, workLogId);
      await this.assertMayChange(tx, context, workLog);
      if (workLog.archivedAt) {
        throw ApiException.conflict(`Work log ${workLogId} is archived and cannot be changed`);
      }
      // One upload start at a time per log, so the cap below cannot be overshot by a race.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attachments:${workLogId}`}))`;
      const active = await tx.attachment.count({ where: { workLogId, archivedAt: null } });
      if (active >= MAX_ATTACHMENTS_PER_WORK_LOG) {
        throw ApiException.conflict(
          `A work log can hold at most ${MAX_ATTACHMENTS_PER_WORK_LOG} attachments`,
        );
      }
      const created = await tx.attachment.create({
        data: {
          organizationId,
          workLogId,
          uploadedById,
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          storageKey: attachmentStorageKey(organizationId, workLogId, input.mimeType),
          status: 'pending',
        },
      });
      await this.changes.record(tx, {
        organizationId,
        entityType: 'attachment',
        verb: 'upload_started',
        entityId: created.id,
        after: recordOf(created),
      });
      return created;
    });
    return { attachment: toAttachment(row), upload: wire(await this.uploadTarget(row)) };
  }

  /** A fresh upload target for a pending attachment (the earlier one expired or failed). */
  async renewUpload(id: string): Promise<AttachmentUpload> {
    const context = await this.access.context();
    await this.limit('renew', context);
    const { attachment, workLog } = await this.find(this.prisma, context, id);
    await this.assertMayChange(this.prisma, context, workLog);
    assertWritable(attachment, workLog);
    if (attachment.status !== 'pending') {
      throw ApiException.conflict(`Attachment ${id} has already been uploaded`);
    }
    await this.storageCall(() => this.storage.assertAvailable());
    return {
      attachment: toAttachment(attachment),
      upload: wire(await this.uploadTarget(attachment)),
    };
  }

  /**
   * Step 3: verifies the uploaded object and marks the attachment ready. Completing a ready
   * attachment returns it unchanged. An object that is not a valid image of the declared type is
   * deleted and answered with 422; the attachment stays pending, so the client may upload again
   * (`renewUpload`) or archive it.
   *
   * The uploaded file is never served: a re-encoded copy (orientation applied, metadata and
   * appended data dropped) is written under a key only the API writes, becomes the attachment's
   * `storageKey` and gets the thumbnail; the upload object is deleted after the commit.
   * Concurrent completions of the same attachment in this process run one after the other: the
   * second one finds it ready and decodes nothing.
   */
  async complete(id: string): Promise<Attachment> {
    const context = await this.access.context();
    await this.limit('complete', context);
    return this.completions.run(id, () => this.completeOnce(context, id));
  }

  private async completeOnce(context: AccessContext, id: string): Promise<Attachment> {
    const { attachment, workLog } = await this.find(this.prisma, context, id);
    if (attachment.status === 'ready') {
      return this.present(attachment);
    }
    await this.assertMayChange(this.prisma, context, workLog);
    assertWritable(attachment, workLog);

    const key = attachment.storageKey;
    const maxBytes = this.settings.uploadMaxBytes;
    const stored = await this.storageCall(() => this.storage.stat(key));
    if (!stored) {
      throw ApiException.conflict(
        'The upload has not been received yet: upload the file to the upload URL first',
      );
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await this.storageCall(() => this.storage.read(key, maxBytes));
    } catch (error) {
      if (error instanceof StoredFileTooLargeError) {
        await this.discard(key);
        throw ApiException.unprocessable(`The uploaded file is larger than ${maxBytes} bytes`);
      }
      throw error;
    }
    if (!bytes) {
      throw ApiException.conflict('The upload has not been received yet');
    }
    const check = await this.verify(bytes, attachment.mimeType as AttachmentMimeType);
    if (!check.ok) {
      await this.discard(key);
      throw ApiException.unprocessable(REJECTION_MESSAGES[check.reason], [
        { path: 'file', message: check.reason },
      ]);
    }
    const { image } = check;
    const verifiedKey = verifiedKeyOf(key);
    const thumbnailKey = thumbnailKeyOf(verifiedKey);

    let won = false;
    let row: AttachmentRow;
    try {
      await this.storageCall(async () => {
        await this.storage.put(verifiedKey, image.data, image.mimeType);
        await this.storage.put(thumbnailKey, image.thumbnail, THUMBNAIL_MIME_TYPE);
      });
      row = await this.prisma.$transaction(async (tx) => {
        // Only a still-pending, not archived attachment is completed: a concurrent `complete`
        // (another API instance) or `archive` that won leaves nothing to do here.
        const { count } = await tx.attachment.updateMany({
          where: { id, status: 'pending', archivedAt: null, storageKey: key },
          data: {
            status: 'ready',
            storageKey: verifiedKey,
            sizeBytes: image.data.byteLength,
            width: image.width,
            height: image.height,
            thumbnailKey,
            completedAt: this.clock.now(),
          },
        });
        const current = await tx.attachment.findUniqueOrThrow({ where: { id } });
        if (count === 0) {
          if (current.status !== 'ready') {
            throw ApiException.conflict(`Attachment ${id} is archived and cannot be changed`);
          }
          return current;
        }
        await this.changes.record(tx, {
          organizationId: context.organizationId,
          entityType: 'attachment',
          verb: 'completed',
          entityId: id,
          before: recordOf(attachment),
          after: recordOf(current),
        });
        won = true;
        return current;
      });
    } finally {
      if (!won) {
        // Nothing points at the copies written above (another completion or an archive won, or
        // a step failed): remove them.
        await this.removeQuietly([verifiedKey, thumbnailKey], 'unused verified copy');
      }
    }
    if (won) {
      // The upload object is no longer referenced: an upload URL that is still valid can only
      // write bytes nobody serves. A failure leaves those bytes behind: logged, not fatal.
      await this.removeQuietly([key], 'upload object');
    }
    return this.present(row);
  }

  /** Verification and re-encoding, within the process-wide decode limit (503 when saturated). */
  private async verify(bytes: Uint8Array, mimeType: AttachmentMimeType): Promise<ImageCheck> {
    try {
      return await this.images.verify(bytes, mimeType);
    } catch (error) {
      if (error instanceof ConcurrencyLimitTimeoutError) {
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'service_unavailable',
          'The server is busy processing other photos. Try again shortly.',
          undefined,
          5,
        );
      }
      throw error;
    }
  }

  /** Deletes objects; a failure is logged (without the keys) and otherwise ignored. */
  private async removeQuietly(keys: string[], what: string): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch (error) {
        const reason = error instanceof Error ? error.name : 'error';
        this.logger.warn(`Could not delete an ${what} from the file storage: ${reason}`);
      }
    }
  }

  /**
   * Archiving an archived attachment changes and records nothing. The stored file and thumbnail
   * of a ready attachment are kept (history); no URL is signed for an archived attachment. The
   * upload object of a pending one is purged by the cleanup once its upload URL has expired.
   */
  async archive(id: string): Promise<Attachment> {
    const context = await this.access.context();
    const row = await this.prisma.$transaction(async (tx) => {
      const found = await this.find(tx, context, id);
      if (found.attachment.archivedAt !== null) {
        return found.attachment;
      }
      await this.assertMayChange(tx, context, found.workLog);
      const archived = await tx.attachment.update({
        where: { id },
        data: { archivedAt: this.clock.now() },
      });
      await this.changes.record(tx, {
        organizationId: context.organizationId,
        entityType: 'attachment',
        verb: 'archived',
        entityId: id,
        before: recordOf(found.attachment),
        after: recordOf(archived),
      });
      return archived;
    });
    return this.present(row);
  }

  /** The attachment with signed URLs when it is ready and not archived. */
  private async present(row: AttachmentRow): Promise<Attachment> {
    if (row.status !== 'ready' || row.archivedAt !== null || !row.thumbnailKey) {
      return toAttachment(row);
    }
    const thumbnailKey = row.thumbnailKey;
    const [original, thumbnail] = await this.storageCall(() =>
      Promise.all([
        this.storage.getDownloadUrl(row.storageKey, { fileName: row.fileName }),
        this.storage.getDownloadUrl(thumbnailKey, { fileName: `thumbnail-${row.fileName}` }),
      ]),
    );
    const expiresAt = Math.min(original.expiresAt.getTime(), thumbnail.expiresAt.getTime());
    return toAttachment(row, {
      url: original.url,
      thumbnailUrl: thumbnail.url,
      urlsExpireAt: new Date(expiresAt).toISOString(),
    });
  }

  private async uploadTarget(row: AttachmentRow): Promise<UploadTarget> {
    return this.storageCall(() =>
      this.storage.createUploadTarget({
        storageKey: row.storageKey,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
      }),
    );
  }

  /** 429 `rate_limited` (with `Retry-After`) once the caller used up the step's budget. */
  private async limit(
    step: keyof typeof UPLOAD_RATE_LIMITS,
    context: AccessContext,
  ): Promise<void> {
    const decision = await this.limiter.hit(
      `attachments:${step}:${context.userId}`,
      UPLOAD_RATE_LIMITS[step],
    );
    if (!decision.allowed) {
      throw ApiException.rateLimited(
        'Too many upload requests. Try again later.',
        decision.retryAfterSeconds,
      );
    }
  }

  /** Deletes a rejected upload. A storage failure here must not hide the 422. */
  private async discard(key: string): Promise<void> {
    await this.storage.delete(key).catch(() => undefined);
  }

  /** Runs a storage call; an unreachable storage becomes 503 `service_unavailable`. */
  private async storageCall<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'service_unavailable',
          'File storage is unavailable. Try again later.',
        );
      }
      throw error;
    }
  }

  /** 403 unless the caller may add, complete or archive attachments on this (visible) work log. */
  private async assertMayChange(
    db: Db,
    context: AccessContext,
    workLog: WorkLogRow,
  ): Promise<void> {
    const editWindowHours = await loadWorkLogEditWindowHours(db, context.organizationId);
    enforce(
      canChangeAttachments(context, workLogFactsOf(workLog), this.clock.now(), editWindowHours),
      'Work log',
      workLog.id,
    );
  }

  /** The attachment and its work log, if the caller may see it; 404 otherwise. */
  private async find(
    db: Db,
    context: AccessContext,
    id: string,
  ): Promise<{ attachment: AttachmentRow; workLog: WorkLogRow }> {
    const row = await db.attachment.findFirst({
      where: {
        id,
        organizationId: context.organizationId,
        AND: [attachmentVisibilityWhere(context) as Prisma.AttachmentWhereInput],
      },
      include: { workLog: true },
    });
    if (!row) {
      throw ApiException.notFound('Attachment', id);
    }
    const { workLog, ...attachment } = row;
    return { attachment, workLog };
  }

  /** The work log, if the caller may see it; 404 otherwise (also for another organization). */
  private async findWorkLog(
    db: Db,
    context: AccessContext,
    workLogId: string,
  ): Promise<WorkLogRow> {
    const workLog = await db.workLog.findFirst({
      where: {
        id: workLogId,
        organizationId: context.organizationId,
        AND: [workLogVisibilityWhere(context) as Prisma.WorkLogWhereInput],
      },
    });
    if (!workLog) {
      throw ApiException.notFound('Work log', workLogId);
    }
    return workLog;
  }
}

/** 409 for an upload step on an archived attachment or on an archived work log. */
function assertWritable(attachment: AttachmentRow, workLog: WorkLogRow): void {
  if (attachment.archivedAt) {
    throw ApiException.conflict(`Attachment ${attachment.id} is archived and cannot be changed`);
  }
  if (workLog.archivedAt) {
    throw ApiException.conflict(`Work log ${workLog.id} is archived and cannot be changed`);
  }
}

function wire(target: UploadTarget): AttachmentUpload['upload'] {
  return {
    url: target.url,
    method: target.method,
    headers: target.headers,
    expiresAt: target.expiresAt.toISOString(),
  };
}
