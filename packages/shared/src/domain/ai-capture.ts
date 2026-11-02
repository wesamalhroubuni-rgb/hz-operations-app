import { z } from 'zod';
import type { ApiCallOptions, ApiResult, ApiTransport } from '../api-client/client.js';
import { localeSchema } from '../common/locale.js';
import { paginatedSchema, paginationQuerySchema, type Paginated } from '../common/pagination.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';
import {
  ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  uploadTargetSchema,
} from './attachments.js';
import { customFieldValuesSchema } from './custom-fields.js';
import { nullableIsoDateTimeSchema, type ListQueryParams } from './shared.js';

// Smart capture (Phase 7, ADR-0010): a worker's voice note, photo or text becomes a PROPOSED work
// log that the worker reviews, edits and confirms. Nothing is saved as a work log until the
// worker confirms it with the ordinary `POST /work-logs` (`source: 'ai_assisted'`,
// `aiProposalId: <capture id>`).
//
// Flow (every route under the policy `ai_capture.use`, own captures only; others are 404):
// 1. `POST /ai/capture` with a `clientId` (idempotent: the same clientId returns the same
//    capture, 200 instead of 201).
//    - `text`: processed at once; answers the capture `proposed` or `failed`.
//    - `voice` / `photo`: answers `awaiting_upload` with `upload` (a signed PUT, type and size
//      signed, API-chosen key: the same rules as photos, ADR-0006). The phone PUTs the bytes.
// 2. `POST /ai/capture/:id/process`: the API verifies the bytes (photo: decoded and re-encoded;
//    audio: type by magic bytes and size), transcribes a voice note, asks the model, validates
//    the answer against the log types' field schema (one retry), and answers `proposed` or
//    `failed` (`failureReason`, transcript kept). Repeating it on a processed capture returns it
//    unchanged. A provider failure is 503 `ai_unavailable` and leaves the capture `pending`.
// 3. The worker confirms through `POST /work-logs`, or `POST /ai/capture/:id/discard`.
//
// Refusals: 403 `ai_disabled` (organization switch off), 429 `ai_limit_reached` (daily limit),
// 429 `rate_limited` (per-user per-minute limit, Retry-After), 503 `ai_unavailable`.

/** Must match the Prisma enum `SmartCaptureInputKind`, in order. */
export const SMART_CAPTURE_INPUT_KINDS = ['voice', 'photo', 'text'] as const;
export const smartCaptureInputKindSchema = z.enum(SMART_CAPTURE_INPUT_KINDS);
export type SmartCaptureInputKind = z.infer<typeof smartCaptureInputKindSchema>;

/** Must match the Prisma enum `SmartCaptureStatus`, in order. See the Prisma comment. */
export const SMART_CAPTURE_STATUSES = [
  'awaiting_upload',
  'pending',
  'processing',
  'proposed',
  'failed',
  'confirmed',
  'discarded',
] as const;
export const smartCaptureStatusSchema = z.enum(SMART_CAPTURE_STATUSES);
export type SmartCaptureStatus = z.infer<typeof smartCaptureStatusSchema>;

/**
 * Why a capture ended `failed`. The worker is told "couldn't understand, please fill in
 * manually"; the transcript (if any) is kept and shown.
 * - `input_unusable`: the uploaded bytes are not a usable audio file or image.
 * - `transcription_empty`: speech-to-text heard nothing.
 * - `output_invalid`: the model's answer failed the schema twice (first try and one retry).
 * - `refused`: the model declined the request.
 * - `provider_rejected`: the AI provider rejected the request itself (HTTP 400, 401, 403, 404,
 *   422: a configuration problem such as a bad key or an unknown model, not an outage); final,
 *   logged as an error for the operator.
 */
export const SMART_CAPTURE_FAILURE_REASONS = [
  'input_unusable',
  'transcription_empty',
  'output_invalid',
  'refused',
  'provider_rejected',
] as const;
export const smartCaptureFailureReasonSchema = z.enum(SMART_CAPTURE_FAILURE_REASONS);
export type SmartCaptureFailureReason = z.infer<typeof smartCaptureFailureReasonSchema>;

/**
 * Voice note types the API accepts. Expo's recorder writes AAC in an MP4 container
 * (`audio/mp4`, `.m4a`) on Android and iOS; the others are for the web and later clients. All are
 * accepted by the speech-to-text provider (ADR-0010).
 */
export const AI_CAPTURE_AUDIO_MIME_TYPES = [
  'audio/mp4',
  'audio/mpeg',
  'audio/webm',
  'audio/ogg',
  'audio/wav',
] as const;
export const aiCaptureAudioMimeTypeSchema = z.enum(AI_CAPTURE_AUDIO_MIME_TYPES);
export type AiCaptureAudioMimeType = z.infer<typeof aiCaptureAudioMimeTypeSchema>;

/**
 * Client timeout of the calls that run the AI (`create` of a text capture, `process`): the API
 * bounds one call at about three provider timeouts (`AI_REQUEST_TIMEOUT_MS`: transcription,
 * extraction, one retry), so the default 10 s of the transport is far too short.
 */
export const AI_CAPTURE_CLIENT_TIMEOUT_MS = 120_000;

/** Longest voice note, in milliseconds (2 minutes): bounds cost and the request time. */
export const AI_CAPTURE_MAX_AUDIO_MS = 120_000;
/** Largest voice note, in bytes (8 MiB; two minutes of AAC at 128 kbit/s is under 2 MiB). */
export const AI_CAPTURE_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** Longest typed text a capture accepts. */
export const AI_CAPTURE_MAX_TEXT_LENGTH = 4000;
/** Longest note a worker can add to a photo capture. */
export const AI_CAPTURE_MAX_PHOTO_NOTE_LENGTH = 500;
/** Input bytes (audio, photo) are deleted this many days after the capture was created... */
export const AI_CAPTURE_INPUT_RETENTION_DAYS = 30;
/** ...or this many days after it was confirmed or discarded, whichever comes first. */
export const AI_CAPTURE_DECIDED_INPUT_RETENTION_DAYS = 7;

/**
 * Limits of what the model is offered for one capture (and so of the output schema's size): the
 * worker's active log types, their open assigned tasks, their visible sites. Beyond these the
 * API offers the context's own task/site/log type plus the most recently used.
 */
export const AI_CAPTURE_MAX_LOG_TYPES = 20;
export const AI_CAPTURE_MAX_TASKS = 30;
export const AI_CAPTURE_MAX_SITES = 30;

/** How sure the model is of one proposed field. Shown as a hint next to the field. */
export const AI_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const aiConfidenceLevelSchema = z.enum(AI_CONFIDENCE_LEVELS);
export type AiConfidenceLevel = z.infer<typeof aiConfidenceLevelSchema>;

/**
 * What the worker had open when capturing. Hints only: every id is checked against the
 * worker's visibility when processing (an invisible or archived one is dropped, never an error),
 * and again by `POST /work-logs` when the log is created.
 */
export const smartCaptureContextSchema = z.strictObject({
  taskId: idSchema.nullable().optional(),
  siteId: idSchema.nullable().optional(),
  logTypeId: idSchema.nullable().optional(),
  /** The phone's clock when the worker recorded it; the proposed `occurredAt` defaults to it. */
  capturedAt: isoDateTimeSchema,
  /** The worker's app language, a hint to speech-to-text (which also detects the language). */
  languageHint: localeSchema.optional(),
});
export type SmartCaptureContext = z.infer<typeof smartCaptureContextSchema>;

export const createSmartCaptureSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    clientId: idSchema,
    context: smartCaptureContextSchema,
    text: z.string().trim().min(1).max(AI_CAPTURE_MAX_TEXT_LENGTH),
  }),
  z.strictObject({
    kind: z.literal('voice'),
    clientId: idSchema,
    context: smartCaptureContextSchema,
    mimeType: aiCaptureAudioMimeTypeSchema,
    sizeBytes: z.number().int().min(1).max(AI_CAPTURE_MAX_AUDIO_BYTES),
    durationMs: z.number().int().min(1).max(AI_CAPTURE_MAX_AUDIO_MS),
  }),
  z.strictObject({
    kind: z.literal('photo'),
    clientId: idSchema,
    context: smartCaptureContextSchema,
    mimeType: z.enum(ATTACHMENT_MIME_TYPES),
    /** The API's `UPLOAD_MAX_BYTES` is authoritative and may be lower. */
    sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_SIZE_BYTES),
    /** Optional words from the worker to go with the photo. */
    note: z.string().trim().min(1).max(AI_CAPTURE_MAX_PHOTO_NOTE_LENGTH).optional(),
  }),
]);
export type CreateSmartCapture = z.infer<typeof createSmartCaptureSchema>;
export type CreateSmartCaptureInput = z.input<typeof createSmartCaptureSchema>;

/**
 * The proposed work log, ready to pre-fill the New log form. Every id is one the worker can see
 * (re-checked by the API); `customFields` passed `validateCustomFieldValues` for `logTypeId`
 * except that required fields may be missing (the worker completes them).
 */
export const smartCaptureProposalSchema = z.object({
  logTypeId: idSchema.nullable(),
  taskId: idSchema.nullable(),
  siteId: idSchema.nullable(),
  text: z.string().nullable(),
  customFields: customFieldValuesSchema,
  /** When the work happened, if the input said so; otherwise the context's `capturedAt`. */
  occurredAt: nullableIsoDateTimeSchema,
});
export type SmartCaptureProposal = z.infer<typeof smartCaptureProposalSchema>;

/** Confidence per proposed field; null where nothing was proposed. Keys of `customFields` are field keys. */
export const smartCaptureConfidenceSchema = z.object({
  logType: aiConfidenceLevelSchema.nullable(),
  task: aiConfidenceLevelSchema.nullable(),
  site: aiConfidenceLevelSchema.nullable(),
  text: aiConfidenceLevelSchema.nullable(),
  customFields: z.record(z.string(), aiConfidenceLevelSchema),
});
export type SmartCaptureConfidence = z.infer<typeof smartCaptureConfidenceSchema>;

/** A capture as its worker sees it. No storage key, no model or prompt details. */
export const smartCaptureSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  clientId: idSchema,
  workerId: idSchema,
  inputKind: smartCaptureInputKindSchema,
  status: smartCaptureStatusSchema,
  failureReason: smartCaptureFailureReasonSchema.nullable(),
  context: z.object({
    taskId: idSchema.nullable(),
    siteId: idSchema.nullable(),
    logTypeId: idSchema.nullable(),
    capturedAt: isoDateTimeSchema,
    languageHint: localeSchema.nullable(),
  }),
  /** Voice: what speech-to-text heard. Text: the worker's text. Photo: the worker's note or null. */
  transcript: z.string().nullable(),
  detectedLanguage: z.string().nullable(),
  /** Set when `proposed` (and kept after `confirmed` / `discarded`). */
  proposal: smartCaptureProposalSchema.nullable(),
  confidence: smartCaptureConfidenceSchema.nullable(),
  /** The work log created from it, once `confirmed`. */
  workLogId: idSchema.nullable(),
  /** True once the retention job deleted the audio or photo bytes. */
  inputPurged: z.boolean(),
  processedAt: nullableIsoDateTimeSchema,
  decidedAt: nullableIsoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SmartCapture = z.infer<typeof smartCaptureSchema>;

/**
 * Answer of `POST /ai/capture` and `POST /ai/capture/:id/upload-url`. `upload` is where to PUT
 * the voice note or photo while the capture is `awaiting_upload`; null otherwise (text, or a
 * repeated create of a capture already past that step).
 */
export const smartCaptureStartedSchema = z.object({
  capture: smartCaptureSchema,
  upload: uploadTargetSchema.nullable(),
});
export type SmartCaptureStarted = z.infer<typeof smartCaptureStartedSchema>;

export const listSmartCapturesQuerySchema = paginationQuerySchema.extend({
  status: smartCaptureStatusSchema.optional(),
});
export type ListSmartCapturesQuery = z.infer<typeof listSmartCapturesQuerySchema>;

export const smartCaptureListSchema = paginatedSchema(smartCaptureSchema);

/**
 * `WorkLog.aiMetadata` of an `ai_assisted` log, written by the API when the log is created with
 * `aiProposalId` (never accepted from a client). Field names are `logTypeId`, `taskId`,
 * `siteId`, `text`, `occurredAt` and `customFields.<key>`.
 */
export const aiWorkLogMetadataSchema = z.looseObject({
  captureId: idSchema,
  inputKind: smartCaptureInputKindSchema,
  /** The capture's AiTrace ids (transcription, extraction, retry). */
  traceIds: z.array(idSchema),
  /** Model and prompt of the extraction that produced the proposal. */
  model: z.string().nullable(),
  promptId: z.string().nullable(),
  promptVersion: z.number().int().nullable(),
  /** Proposed fields the worker left as proposed. */
  keptFields: z.array(z.string()),
  /** Proposed fields the worker changed or cleared. */
  changedFields: z.array(z.string()),
  /** Fields the worker filled that the proposal left empty. */
  addedFields: z.array(z.string()),
});
export type AiWorkLogMetadata = z.infer<typeof aiWorkLogMetadataSchema>;

export function smartCaptureEndpoints(transport: ApiTransport) {
  return {
    /** 201 for a new capture, 200 for a repeated `clientId`. */
    create(
      body: CreateSmartCaptureInput,
      options: ApiCallOptions = {},
    ): Promise<ApiResult<SmartCaptureStarted>> {
      return transport.request({
        method: 'POST',
        path: '/ai/capture',
        body,
        headers: options.headers,
        schema: smartCaptureStartedSchema,
        timeoutMs: AI_CAPTURE_CLIENT_TIMEOUT_MS,
      });
    },
    /** The caller's own captures, newest first. */
    list(
      query: ListQueryParams<typeof listSmartCapturesQuerySchema> = {},
    ): Promise<ApiResult<Paginated<SmartCapture>>> {
      return transport.request({ path: '/ai/capture', query, schema: smartCaptureListSchema });
    },
    get(id: string): Promise<ApiResult<SmartCapture>> {
      return transport.request({ path: `/ai/capture/${id}`, schema: smartCaptureSchema });
    },
    /** A fresh upload URL while `awaiting_upload`. */
    renewUpload(id: string): Promise<ApiResult<SmartCaptureStarted>> {
      return transport.request({
        method: 'POST',
        path: `/ai/capture/${id}/upload-url`,
        schema: smartCaptureStartedSchema,
      });
    },
    /** Verifies the uploaded input and runs the AI; answers `proposed` or `failed`. */
    process(id: string, options: ApiCallOptions = {}): Promise<ApiResult<SmartCapture>> {
      return transport.request({
        method: 'POST',
        path: `/ai/capture/${id}/process`,
        headers: options.headers,
        schema: smartCaptureSchema,
        timeoutMs: AI_CAPTURE_CLIENT_TIMEOUT_MS,
      });
    },
    /** The worker does not want this proposal. Idempotent. */
    discard(id: string, options: ApiCallOptions = {}): Promise<ApiResult<SmartCapture>> {
      return transport.request({
        method: 'POST',
        path: `/ai/capture/${id}/discard`,
        headers: options.headers,
        schema: smartCaptureSchema,
      });
    },
  };
}
