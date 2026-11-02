import type {
  ApiCallOptions,
  ApiClient,
  ApiFailure,
  CreateSmartCaptureInput,
  SmartCapture,
  UploadPut,
  UploadTargetInfo,
} from '@ops/shared';

import { classifyApiFailure, type ClassifiedFailure } from './engineErrors';
import type {
  DiscardSmartCaptureMutation,
  LocalAudioStore,
  LocalPhotoStore,
  QueueItem,
  SmartCaptureCheckpoint,
  SmartCaptureMutation,
  SmartCaptureResults,
  WriteQueue,
} from './types';

// How the sync engine sends a queued smart capture (Phase 7, ADR-0010), in steps that are each
// safe to repeat, with the progress saved in the item's checkpoint between them:
//
// 1. `POST /ai/capture` with the capture's clientId (a repeat returns the same capture);
// 2. for a voice note or photo, PUT the bytes to the signed URL (a fresh one from
//    `POST /ai/capture/:id/upload-url` when the first is gone or expired);
// 3. `POST /ai/capture/:id/process`, which answers `proposed` or `failed`.
//
// The item is done when the capture is processed; the result goes to the user's local captures
// (the review screen) and the voice note file is deleted (the server has it). A Snap photo stays
// for the review: the worker may attach it to the confirmed log.
//
// Final (kept as `failed_permanent` for the worker): `ai_disabled`, `ai_limit_reached`, a missing
// file, and the usual refusals. Retried: `ai_unavailable`, `rate_limited`, network problems,
// `request_in_progress`, and "upload first" (the PUT is done again).

export type StepOutcome =
  { ok: true; capture: SmartCapture | null } | { ok: false; failure: ClassifiedFailure };

export interface SmartCaptureStepDeps {
  api: Pick<ApiClient, 'smartCapture'>;
  queue: Pick<WriteQueue, 'saveCaptureCheckpoint'>;
  photos: Pick<LocalPhotoStore, 'exists'>;
  audio?: Pick<LocalAudioStore, 'exists'>;
  /** The platform PUT of a local file (expo-file-system on a phone). */
  putFile: (uri: string, localId: string) => UploadPut;
  requestOptions: (item: QueueItem) => ApiCallOptions;
}

/** The capture is settled: processing it again returns it unchanged. */
export function isSettledCapture(capture: Pick<SmartCapture, 'status'>): boolean {
  return (
    capture.status === 'proposed' ||
    capture.status === 'failed' ||
    capture.status === 'confirmed' ||
    capture.status === 'discarded'
  );
}

/**
 * Judges a failed capture call. Like any queued write, except that the organization's daily AI
 * limit (429 `ai_limit_reached`) is final for this capture: the worker fills the form by hand.
 */
export function classifyCaptureFailure(failure: ApiFailure): ClassifiedFailure {
  const classified = classifyApiFailure(failure);
  if (failure.kind === 'http' && failure.error.code === 'ai_limit_reached') {
    return { ...classified, disposition: 'permanent' };
  }
  return classified;
}

/** The body of `POST /ai/capture` for a queued capture. */
export function createCaptureBody(mutation: SmartCaptureMutation): CreateSmartCaptureInput {
  const { captureClientId: clientId, context, input } = mutation;
  switch (input.kind) {
    case 'text':
      return { kind: 'text', clientId, context, text: input.text };
    case 'voice':
      return {
        kind: 'voice',
        clientId,
        context,
        mimeType: input.audio.mimeType,
        sizeBytes: input.audio.sizeBytes,
        durationMs: input.audio.durationMs,
      };
    case 'photo':
      return {
        kind: 'photo',
        clientId,
        context,
        mimeType: input.photo.mimeType,
        sizeBytes: input.photo.sizeBytes,
        ...(input.note ? { note: input.note } : {}),
      };
  }
}

function localFailure(code: 'photo_missing' | 'audio_missing'): StepOutcome {
  return {
    ok: false,
    failure: {
      disposition: 'permanent',
      connection: false,
      error: {
        code,
        message:
          code === 'audio_missing'
            ? 'The voice note is no longer on this phone'
            : 'The photo file is no longer on this phone',
        status: null,
      },
    },
  };
}

function putFailure(status: number, message: string): StepOutcome {
  // No answer: the link is down. Any refusal of the storage (an expired URL, ...) is retried
  // with a fresh URL.
  return {
    ok: false,
    failure:
      status === 0
        ? {
            disposition: 'retryable',
            connection: true,
            error: { code: 'network', message, status: null },
          }
        : {
            disposition: 'retryable',
            connection: false,
            error: { code: 'service_unavailable', message, status },
          },
  };
}

/** Runs the steps of one queued capture. Never throws for an API or storage answer. */
export async function sendSmartCapture(
  deps: SmartCaptureStepDeps,
  item: QueueItem,
  mutation: SmartCaptureMutation,
): Promise<StepOutcome> {
  const { api, queue } = deps;
  const input = mutation.input;
  let checkpoint: SmartCaptureCheckpoint = { ...mutation.checkpoint };
  const save = async (next: SmartCaptureCheckpoint) => {
    checkpoint = next;
    await queue.saveCaptureCheckpoint(item.id, next);
  };
  const file =
    input.kind === 'voice'
      ? { uri: input.audio.uri, localId: input.audio.localId }
      : input.kind === 'photo'
        ? { uri: input.photo.uri, localId: input.photo.localId }
        : null;

  if (file !== null && !checkpoint.uploaded) {
    const present =
      input.kind === 'voice'
        ? await (deps.audio?.exists(input.audio) ?? Promise.resolve(true))
        : input.kind === 'photo'
          ? await deps.photos.exists(input.photo)
          : true;
    if (!present) return localFailure(input.kind === 'voice' ? 'audio_missing' : 'photo_missing');
  }

  let upload: UploadTargetInfo | null = null;
  if (checkpoint.captureId === null) {
    const created = await api.smartCapture.create(
      createCaptureBody(mutation),
      deps.requestOptions(item),
    );
    if (!created.ok) return { ok: false, failure: classifyCaptureFailure(created.failure) };
    const capture = created.data.capture;
    upload = created.data.upload;
    await save({
      ...checkpoint,
      captureId: capture.id,
      uploaded: file === null || capture.status !== 'awaiting_upload',
    });
    if (isSettledCapture(capture)) {
      await save({ ...checkpoint, processed: true });
      return { ok: true, capture };
    }
  }
  const captureId = checkpoint.captureId as string;

  if (file !== null && !checkpoint.uploaded) {
    if (upload === null) {
      const renewed = await api.smartCapture.renewUpload(captureId);
      if (renewed.ok) {
        upload = renewed.data.upload;
        if (upload === null) await save({ ...checkpoint, uploaded: true });
      } else if (renewed.failure.kind === 'http' && renewed.failure.error.code === 'conflict') {
        // It does not wait for an upload any more: the bytes arrived earlier.
        await save({ ...checkpoint, uploaded: true });
      } else {
        return { ok: false, failure: classifyCaptureFailure(renewed.failure) };
      }
    }
    if (upload !== null && !checkpoint.uploaded) {
      const put = await deps.putFile(file.uri, file.localId)(upload, () => undefined);
      if (!put.ok) return putFailure(put.status, put.message);
      await save({ ...checkpoint, uploaded: true });
    }
  }

  const processed = await api.smartCapture.process(captureId, deps.requestOptions(item));
  if (!processed.ok) {
    const failure = processed.failure;
    if (failure.kind === 'http' && failure.error.code === 'conflict' && file !== null) {
      // "Upload first": the bytes did not arrive; PUT them again next time.
      await save({ ...checkpoint, uploaded: false });
      return {
        ok: false,
        failure: { ...classifyCaptureFailure(failure), disposition: 'retryable' },
      };
    }
    return { ok: false, failure: classifyCaptureFailure(failure) };
  }
  await save({ ...checkpoint, processed: true });
  return { ok: true, capture: processed.data };
}

/** Sends a queued discard. A capture already gone or confirmed leaves nothing to discard. */
export async function sendDiscardSmartCapture(
  deps: Pick<SmartCaptureStepDeps, 'api' | 'requestOptions'>,
  item: QueueItem,
  mutation: DiscardSmartCaptureMutation,
): Promise<StepOutcome> {
  const result = await deps.api.smartCapture.discard(mutation.captureId, deps.requestOptions(item));
  if (result.ok) return { ok: true, capture: result.data };
  const failure = result.failure;
  if (
    failure.kind === 'http' &&
    (failure.error.code === 'not_found' || failure.error.code === 'conflict')
  ) {
    return { ok: true, capture: null };
  }
  return { ok: false, failure: classifyCaptureFailure(failure) };
}

/** Stores a processed capture for the review screen. */
export async function keepResult(
  results: SmartCaptureResults | undefined,
  mutation: SmartCaptureMutation,
  capture: SmartCapture | null,
): Promise<void> {
  if (capture !== null && results) await results.saveResult(mutation.captureClientId, capture);
}
