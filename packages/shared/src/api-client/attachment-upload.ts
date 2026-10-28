import { isRetryableApiErrorCode } from '../common/errors.js';
import type {
  Attachment,
  AttachmentUpload,
  StartAttachmentUpload,
  StartedAttachmentUpload,
  UploadTargetInfo,
} from '../domain/attachments.js';
import type { ApiCallOptions, ApiFailure, ApiResult } from './client.js';

// The client side of the attachment upload flow, shared by the mobile app and the web dashboard:
//
//   1. `startUpload(workLogId, { fileName, mimeType, sizeBytes })` creates a pending attachment
//      and returns a short-lived URL;
//   2. the client PUTs the bytes to that URL with exactly the returned headers (the platform
//      supplies the PUT, because how a file is read and how progress is reported differ);
//   3. `complete(id)` makes the API verify the stored object and mark the attachment ready.
//
// A failed attempt can be resumed: the progress so far (`UploadCheckpoint`) says which pending
// attachment exists and whether its bytes were stored, so a retry renews the URL of that same
// attachment instead of creating another one, and skips the PUT when only `complete` failed.

/** The part of the API client this module uses (`client.attachments`). */
export interface AttachmentUploadApi {
  startUpload(
    workLogId: string,
    body: StartAttachmentUpload,
    options?: ApiCallOptions,
  ): Promise<ApiResult<StartedAttachmentUpload>>;
  renewUpload(id: string, options?: ApiCallOptions): Promise<ApiResult<AttachmentUpload>>;
  complete(id: string, options?: ApiCallOptions): Promise<ApiResult<Attachment>>;
  get(id: string): Promise<ApiResult<Attachment>>;
}

/** Result of the platform's PUT of the bytes to a signed URL. */
export type UploadPutResult =
  | { ok: true }
  /** `status` is the storage's HTTP status; 0 means no answer (offline, timeout). */
  | { ok: false; status: number; message: string };

/**
 * Sends the file to `target.url` with `target.method` and exactly `target.headers`, reporting
 * progress as a fraction from 0 to 1 when the platform can. Must not throw.
 */
export type UploadPut = (
  target: UploadTargetInfo,
  onProgress: (fraction: number) => void,
) => Promise<UploadPutResult>;

/** How far an earlier attempt got. Keep it with the photo and pass it to the next attempt. */
export interface UploadCheckpoint {
  attachmentId: string | null;
  /** The PUT succeeded; only `complete` is left. */
  stored: boolean;
}

export const EMPTY_UPLOAD_CHECKPOINT: UploadCheckpoint = { attachmentId: null, stored: false };

export type UploadStep = 'start' | 'renew' | 'put' | 'complete';

export type UploadFailure = {
  step: UploadStep;
  /** Worth trying again later as it is (no connection, timeout, server or storage trouble). */
  retryable: boolean;
  /** The API's failure, for the steps that call the API. */
  api: ApiFailure | null;
  /** The storage's HTTP status for a failed PUT (0: no answer). */
  putStatus: number | null;
  message: string;
};

export type AttachmentUploadResult =
  | { ok: true; attachment: Attachment; checkpoint: UploadCheckpoint }
  | { ok: false; failure: UploadFailure; checkpoint: UploadCheckpoint };

export interface UploadAttachmentInput {
  workLogId: string;
  file: StartAttachmentUpload;
  put: UploadPut;
  /** Overall progress from 0 to 1 (the PUT is most of it). */
  onProgress?: (fraction: number) => void;
  /** From an earlier failed attempt of the same photo. */
  checkpoint?: UploadCheckpoint;
  /**
   * Passed to every API call of the upload (the offline queue's `offlineSyncHeaders(...)`). The
   * photo's `clientId` goes in `file`.
   */
  requestOptions?: ApiCallOptions;
}

/**
 * True for an API failure that may go away by itself: no answer, 408, 429, a 5xx, or a code of
 * `RETRYABLE_API_ERROR_CODES` (`request_in_progress`).
 */
export function isRetryableApiFailure(failure: ApiFailure): boolean {
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    return true;
  }
  if (failure.kind === 'http' && isRetryableApiErrorCode(failure.error.code)) {
    return true;
  }
  const status = failure.status;
  return status === 408 || status === 429 || status >= 500;
}

/** True for a PUT failure that may go away by itself. */
export function isRetryablePutStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Whether a failed PUT means the signed URL itself is no longer good (expired or its signature
 * refused). S3-compatible storages answer 403 for both; 400 can mean an expired request too.
 */
export function isExpiredUrlStatus(status: number): boolean {
  return status === 403 || status === 400;
}

function apiFailure(step: UploadStep, failure: ApiFailure): UploadFailure {
  return {
    step,
    retryable: isRetryableApiFailure(failure),
    api: failure,
    putStatus: null,
    message: failure.message,
  };
}

/** The target is about to expire or has: renew it before sending megabytes to it. */
export function isTargetExpired(target: UploadTargetInfo, now: Date, marginMs = 15_000): boolean {
  const expiresAt = Date.parse(target.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - marginMs <= now.getTime();
}

/**
 * Runs (or resumes) the upload of one file to one work log. Never throws. On failure the returned
 * checkpoint says how far it got; pass it to the next attempt.
 */
export async function uploadAttachment(
  api: AttachmentUploadApi,
  input: UploadAttachmentInput,
  now: () => Date = () => new Date(),
): Promise<AttachmentUploadResult> {
  const report = input.onProgress ?? (() => undefined);
  const options = input.requestOptions ?? {};
  let checkpoint: UploadCheckpoint = { ...(input.checkpoint ?? EMPTY_UPLOAD_CHECKPOINT) };

  // Only `complete` was left last time.
  if (checkpoint.attachmentId !== null && checkpoint.stored) {
    const completed = await api.complete(checkpoint.attachmentId, options);
    if (completed.ok) {
      report(1);
      return { ok: true, attachment: completed.data, checkpoint };
    }
    if (isRetryableApiFailure(completed.failure)) {
      return { ok: false, failure: apiFailure('complete', completed.failure), checkpoint };
    }
    // The API did not find the bytes after all: send them again below.
    checkpoint = { ...checkpoint, stored: false };
  }

  report(0);
  let target: UploadTargetInfo;
  let attachmentId: string;
  if (checkpoint.attachmentId === null) {
    const started = await api.startUpload(input.workLogId, input.file, options);
    if (!started.ok) {
      return { ok: false, failure: apiFailure('start', started.failure), checkpoint };
    }
    attachmentId = started.data.attachment.id;
    if (started.data.upload === null) {
      // A repeated start (same clientId) of a photo an earlier attempt already finished.
      checkpoint = { attachmentId, stored: true };
      if (started.data.attachment.status === 'ready') {
        report(1);
        return { ok: true, attachment: started.data.attachment, checkpoint };
      }
      const completedNow = await api.complete(attachmentId, options);
      if (completedNow.ok) {
        report(1);
        return { ok: true, attachment: completedNow.data, checkpoint };
      }
      return { ok: false, failure: apiFailure('complete', completedNow.failure), checkpoint };
    }
    checkpoint = { attachmentId, stored: false };
    target = started.data.upload;
  } else {
    attachmentId = checkpoint.attachmentId;
    const renewed = await renew(api, attachmentId, options);
    if (renewed.kind === 'ready') {
      report(1);
      return {
        ok: true,
        attachment: renewed.attachment,
        checkpoint: { ...checkpoint, stored: true },
      };
    }
    if (renewed.kind === 'failed') {
      return { ok: false, failure: renewed.failure, checkpoint };
    }
    target = renewed.target;
  }

  if (isTargetExpired(target, now())) {
    const renewed = await renew(api, attachmentId, options);
    if (renewed.kind === 'failed') return { ok: false, failure: renewed.failure, checkpoint };
    if (renewed.kind === 'ready') {
      report(1);
      return {
        ok: true,
        attachment: renewed.attachment,
        checkpoint: { ...checkpoint, stored: true },
      };
    }
    target = renewed.target;
  }

  // The PUT is 90% of the work; start and complete share the rest.
  const onPutProgress = (fraction: number) =>
    report(0.05 + 0.9 * Math.min(1, Math.max(0, fraction)));
  let put = await input.put(target, onPutProgress);
  if (!put.ok && isExpiredUrlStatus(put.status)) {
    // The URL expired while waiting (a slow network, a phone asleep): renew once and resend.
    const renewed = await renew(api, attachmentId, options);
    if (renewed.kind === 'failed') return { ok: false, failure: renewed.failure, checkpoint };
    if (renewed.kind === 'ready') {
      report(1);
      return {
        ok: true,
        attachment: renewed.attachment,
        checkpoint: { ...checkpoint, stored: true },
      };
    }
    put = await input.put(renewed.target, onPutProgress);
  }
  if (!put.ok) {
    return {
      ok: false,
      failure: {
        step: 'put',
        retryable: isRetryablePutStatus(put.status) || isExpiredUrlStatus(put.status),
        api: null,
        putStatus: put.status,
        message: put.message,
      },
      checkpoint,
    };
  }
  checkpoint = { ...checkpoint, stored: true };

  const completed = await api.complete(attachmentId, options);
  if (!completed.ok) {
    if (isBytesMissing(completed.failure)) {
      // 409: the storage does not have the bytes (the PUT was lost on the way). Worth sending
      // them again on the next attempt.
      return {
        ok: false,
        failure: { ...apiFailure('complete', completed.failure), retryable: true },
        checkpoint: { ...checkpoint, stored: false },
      };
    }
    return { ok: false, failure: apiFailure('complete', completed.failure), checkpoint };
  }
  report(1);
  return { ok: true, attachment: completed.data, checkpoint };
}

/**
 * `complete` answers 409 `conflict` when the uploaded object is not (yet) in the storage. Other
 * 409 codes (`record_archived`, ...) are final.
 */
function isBytesMissing(failure: ApiFailure): boolean {
  return failure.kind === 'http' && failure.status === 409 && failure.error.code === 'conflict';
}

type RenewOutcome =
  | { kind: 'target'; target: UploadTargetInfo }
  | { kind: 'ready'; attachment: Attachment }
  | { kind: 'failed'; failure: UploadFailure };

/**
 * A fresh URL for a pending attachment. When the API refuses because the attachment is no longer
 * pending (409), it may have been completed by an earlier attempt whose answer was lost: check.
 */
async function renew(
  api: AttachmentUploadApi,
  attachmentId: string,
  options: ApiCallOptions,
): Promise<RenewOutcome> {
  const renewed = await api.renewUpload(attachmentId, options);
  if (renewed.ok) {
    return { kind: 'target', target: renewed.data.upload };
  }
  if (renewed.failure.kind === 'http' && renewed.failure.status === 409) {
    const current = await api.get(attachmentId);
    if (current.ok && current.data.status === 'ready') {
      return { kind: 'ready', attachment: current.data };
    }
  }
  return { kind: 'failed', failure: apiFailure('renew', renewed.failure) };
}

/**
 * Delay before automatic retry number `attempt` (1-based): 2 s, 4 s, 8 s, ... capped at
 * `maxMs`, with up to 20% jitter (`random` returns [0, 1)) so many phones coming back online do
 * not retry in step. Returns null after `maxAttempts`: from then on the person retries by hand.
 */
export function uploadRetryDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; maxAttempts?: number; random?: () => number } = {},
): number | null {
  const { baseMs = 2000, maxMs = 30_000, maxAttempts = 3, random = Math.random } = options;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > maxAttempts) {
    return null;
  }
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential * (1 + 0.2 * random()));
}
