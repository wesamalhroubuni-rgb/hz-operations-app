import { z } from 'zod';

/** Machine-readable error codes. Clients branch on `code`, never on `message`. */
export const API_ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'unprocessable',
  'service_unavailable',
  'internal_error',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** One problem with one part of the input. `path` is dotted, for example `customFields.quantity`. */
export const apiErrorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;

/** Body of every non-2xx response of the API (except GET /health, which keeps its own shape). */
export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  code: apiErrorCodeSchema,
  message: z.string(),
  details: z.array(apiErrorDetailSchema).optional(),
  /** Identifier of the request, also sent as the `x-request-id` response header. */
  correlationId: z.string().nullable(),
  timestamp: z.iso.datetime(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
