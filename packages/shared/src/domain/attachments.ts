import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { nullableIsoDateTimeSchema, type ListQueryParams } from './shared.js';

/** Largest size the metadata accepts (the column is a 32-bit integer): 2 GiB minus one byte. */
export const MAX_ATTACHMENT_SIZE_BYTES = 2_147_483_647;

/**
 * Metadata of a file attached to a work log. The bytes live behind the storage interface
 * (Phase 4); `storageKey` is where.
 */
export const attachmentSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  workLogId: idSchema,
  uploadedById: idSchema,
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  storageKey: z.string(),
  createdAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** The uploader is the acting user. */
export const createAttachmentSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z
    .string()
    .trim()
    .max(127)
    .regex(/^[\w.+-]+\/[\w.+-]+$/, { error: 'must be a MIME type such as image/jpeg' }),
  sizeBytes: z.number().int().min(0).max(MAX_ATTACHMENT_SIZE_BYTES),
  storageKey: z.string().trim().min(1).max(1024),
});
export type CreateAttachment = z.infer<typeof createAttachmentSchema>;

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
    create(workLogId: string, body: CreateAttachment): Promise<ApiResult<Attachment>> {
      return transport.request({
        method: 'POST',
        path: `/work-logs/${workLogId}/attachments`,
        body,
        schema: attachmentSchema,
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
