import { z } from 'zod';
import type { ApiCallOptions, ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { nullableIsoDateTimeSchema, type ListQueryParams } from './shared.js';

/** Image types the API accepts. Phones convert HEIC/HEIF to JPEG before uploading. */
export const ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const attachmentMimeTypeSchema = z.enum(ATTACHMENT_MIME_TYPES);
export type AttachmentMimeType = z.infer<typeof attachmentMimeTypeSchema>;

/**
 * Upper bound the client checks before uploading. The API's own limit (`UPLOAD_MAX_BYTES`) is
 * authoritative and may be lower.
 */
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export const ATTACHMENT_STATUSES = ['pending', 'ready'] as const;
export const attachmentStatusSchema = z.enum(ATTACHMENT_STATUSES);
export type AttachmentStatus = z.infer<typeof attachmentStatusSchema>;

/**
 * A photo attached to a work log. The storage key is never exposed. While `ready`, the response
 * carries short-lived signed URLs to the image and its thumbnail (null while `pending` or for an
 * archived attachment); fetch the attachment again for fresh ones after `urlsExpireAt`.
 */
export const attachmentSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  workLogId: idSchema,
  uploadedById: idSchema,
  /** The device-generated id the upload was started with, or null (ADR-0008). */
  clientId: idSchema.nullable(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  status: attachmentStatusSchema,
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  url: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  urlsExpireAt: nullableIsoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  completedAt: nullableIsoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * Starts an upload. The API creates a `pending` attachment, chooses the storage key, and answers
 * with a short-lived URL the client PUTs the bytes to; then the client calls `complete`.
 *
 * `clientId` (ADR-0008) is generated on the device, one per photo, and makes the start
 * idempotent: starting again with the caller's own clientId on the same log returns the
 * existing attachment (200) with a fresh URL while it is pending, or with `upload: null` once it
 * is ready. A clientId used by somebody else, or on another log, is a 409 `conflict`. Only a
 * clientId declared in the log's create request (`declaredAttachmentClientIds`) lets the author
 * upload after the edit window (for `DECLARED_ATTACHMENT_GRACE_DAYS`).
 */
export const startAttachmentUploadSchema = z.strictObject({
  clientId: idSchema.optional(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: attachmentMimeTypeSchema,
  sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_SIZE_BYTES),
});
export type StartAttachmentUpload = z.infer<typeof startAttachmentUploadSchema>;

/** Where and how to upload the bytes: send exactly these headers with a PUT of the file. */
export const uploadTargetSchema = z.object({
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDateTimeSchema,
});
export type UploadTargetInfo = z.infer<typeof uploadTargetSchema>;

export const attachmentUploadSchema = z.object({
  attachment: attachmentSchema,
  upload: uploadTargetSchema,
});
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

/**
 * Answer of `startUpload`: as {@link attachmentUploadSchema}, except that `upload` is null when a
 * repeated start (same `clientId`) finds the attachment already `ready`: nothing is left to send.
 */
export const startedAttachmentUploadSchema = z.object({
  attachment: attachmentSchema,
  upload: uploadTargetSchema.nullable(),
});
export type StartedAttachmentUpload = z.infer<typeof startedAttachmentUploadSchema>;

export const ATTACHMENT_SORT_FIELDS = ['createdAt', 'fileName', 'sizeBytes'] as const;

export const listAttachmentsQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(ATTACHMENT_SORT_FIELDS, { field: 'createdAt', direction: 'asc' }),
  includeArchived: queryBooleanSchema.default(false),
});
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsQuerySchema>;

export const attachmentListSchema = paginatedSchema(attachmentSchema);

export function attachmentsEndpoints(transport: ApiTransport) {
  return {
    listForWorkLog(
      workLogId: string,
      query: ListQueryParams<typeof listAttachmentsQuerySchema> = {},
    ): Promise<ApiResult<Paginated<Attachment>>> {
      return transport.request({
        path: `/work-logs/${workLogId}/attachments`,
        query,
        schema: attachmentListSchema,
      });
    },
    /**
     * Step 1: creates the pending attachment and returns where to PUT the bytes (201), or the
     * existing one for a repeated `clientId` (200; `upload` null when it is already ready).
     */
    startUpload(
      workLogId: string,
      body: StartAttachmentUpload,
      options: ApiCallOptions = {},
    ): Promise<ApiResult<StartedAttachmentUpload>> {
      return transport.request({
        method: 'POST',
        path: `/work-logs/${workLogId}/attachments`,
        body,
        headers: options.headers,
        schema: startedAttachmentUploadSchema,
      });
    },
    /** Step 2 (after the PUT): the API verifies the stored file and marks it ready. */
    complete(id: string, options: ApiCallOptions = {}): Promise<ApiResult<Attachment>> {
      return transport.request({
        method: 'POST',
        path: `/attachments/${id}/complete`,
        headers: options.headers,
        schema: attachmentSchema,
      });
    },
    /** A fresh upload URL for a pending attachment whose earlier URL expired or failed. */
    renewUpload(id: string, options: ApiCallOptions = {}): Promise<ApiResult<AttachmentUpload>> {
      return transport.request({
        method: 'POST',
        path: `/attachments/${id}/upload-url`,
        headers: options.headers,
        schema: attachmentUploadSchema,
      });
    },
    get(id: string): Promise<ApiResult<Attachment>> {
      return transport.request({ path: `/attachments/${id}`, schema: attachmentSchema });
    },
    archive(id: string): Promise<ApiResult<Attachment>> {
      return transport.request({
        method: 'POST',
        path: `/attachments/${id}/archive`,
        schema: attachmentSchema,
      });
    },
  };
}
