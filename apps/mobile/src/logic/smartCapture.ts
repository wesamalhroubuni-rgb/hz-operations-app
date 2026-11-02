import {
  initialCustomFieldValues,
  type AiConfidenceLevel,
  type CreateWorkLogInput,
  type LogType,
} from '@ops/shared';

import type { LocalSmartCapture, QueueItem, QueueItemError } from '../offline/types';
import type { LogFormValues } from './logForm';

// The review of a smart capture (Phase 7, ADR-0010), as pure functions: what state a capture is
// in, how its proposal fills the New log form, which fields still carry the AI's suggestion (and
// its confidence), and the body that confirms it. The screen only renders.

/**
 * - `waiting`: in the queue (offline, or being processed); the worker can fill the form by hand.
 * - `ready`: the server proposed a log; review it.
 * - `notUnderstood`: the AI could not make sense of it (any `failureReason`, also
 *   `provider_rejected`); fill in by hand, transcript shown.
 * - `notProcessed`: refused for good (smart capture off, the daily limit, the file gone): fill in
 *   by hand; `reason` says why.
 */
export type CaptureState =
  | { kind: 'waiting'; retrying: boolean }
  | { kind: 'ready' }
  | { kind: 'notUnderstood' }
  | { kind: 'notProcessed'; reason: QueueItemError | null };

export function captureState(capture: LocalSmartCapture, item: QueueItem | null): CaptureState {
  const status = capture.capture?.status;
  if (status === 'proposed') return { kind: 'ready' };
  if (status === 'failed') return { kind: 'notUnderstood' };
  if (item === null) return { kind: 'notProcessed', reason: null };
  if (item.state === 'failed_permanent') return { kind: 'notProcessed', reason: item.lastError };
  return { kind: 'waiting', retrying: item.state === 'failed_retryable' };
}

/** What the worker said, typed or noted: the transcript once processed, else their own text. */
export function transcriptOf(capture: LocalSmartCapture): string | null {
  const transcript = capture.capture?.transcript;
  if (transcript) return transcript;
  if (capture.input.kind === 'text') return capture.input.text;
  if (capture.input.kind === 'photo') return capture.input.note;
  return null;
}

/** Whether confirming will be recorded as AI-assisted (the server has a result to confirm). */
export function isAiAssisted(capture: LocalSmartCapture): boolean {
  const status = capture.capture?.status;
  return status === 'proposed' || status === 'failed';
}

/**
 * The New log form filled from a capture: the proposal when there is one (log type, fields,
 * text, task, site, time); otherwise the worker's own words as the notes, and the task and site
 * they had open.
 */
export function formValuesFromCapture(
  capture: LocalSmartCapture,
  logType: LogType | null,
  base: LogFormValues,
): LogFormValues {
  const proposal = capture.capture?.status === 'proposed' ? capture.capture.proposal : null;
  if (proposal) {
    const type = logType && logType.id === proposal.logTypeId ? logType : null;
    return {
      ...base,
      logTypeId: type?.id ?? null,
      customFields: type ? initialCustomFieldValues(type.fields, proposal.customFields) : {},
      text: proposal.text ?? '',
      taskId: proposal.taskId ?? capture.context.taskId ?? base.taskId,
      siteId: proposal.siteId ?? capture.context.siteId ?? base.siteId,
      occurredAt: proposal.occurredAt ?? capture.context.capturedAt,
    };
  }
  return {
    ...base,
    text: transcriptOf(capture) ?? base.text,
    taskId: capture.context.taskId ?? base.taskId,
    siteId: capture.context.siteId ?? base.siteId,
    occurredAt: capture.context.capturedAt,
  };
}

/** Names of the form's fields, as in `aiMetadata`: `logTypeId`, `customFields.<key>`, ... */
export type HintField = 'logTypeId' | 'taskId' | 'siteId' | 'text' | `customFields.${string}`;

/**
 * The confidence hint of every field that still holds the AI's suggestion. A field the worker
 * changed loses its hint (it is theirs now).
 */
export function confidenceHints(
  capture: LocalSmartCapture,
  proposed: LogFormValues,
  current: LogFormValues,
): Partial<Record<HintField, AiConfidenceLevel>> {
  const confidence = capture.capture?.status === 'proposed' ? capture.capture.confidence : null;
  if (!confidence) return {};
  const hints: Partial<Record<HintField, AiConfidenceLevel>> = {};
  const keep = (field: HintField, level: AiConfidenceLevel | null, same: boolean) => {
    if (level && same) hints[field] = level;
  };
  keep('logTypeId', confidence.logType, current.logTypeId === proposed.logTypeId);
  keep('taskId', confidence.task, current.taskId === proposed.taskId);
  keep('siteId', confidence.site, current.siteId === proposed.siteId);
  keep('text', confidence.text, current.text.trim() === proposed.text.trim());
  if (current.logTypeId === proposed.logTypeId) {
    for (const [key, level] of Object.entries(confidence.customFields)) {
      keep(
        `customFields.${key}`,
        level,
        JSON.stringify(current.customFields[key]) === JSON.stringify(proposed.customFields[key]),
      );
    }
  }
  return hints;
}

/**
 * The create body that confirms a capture: `ai_assisted` with the capture's id when the server
 * processed it, an ordinary manual log otherwise.
 */
export function confirmationBody(
  capture: LocalSmartCapture,
  body: CreateWorkLogInput,
): CreateWorkLogInput {
  const { aiProposalId: _ignored, ...rest } = body;
  return isAiAssisted(capture) && capture.capture
    ? { ...rest, source: 'ai_assisted', aiProposalId: capture.capture.id }
    : { ...rest, source: 'manual' };
}

/** Longest voice note, in seconds, as the recorder shows it. */
export function recordingProgress(
  durationMs: number,
  maxMs: number,
): {
  elapsedSeconds: number;
  remainingSeconds: number;
  reachedMax: boolean;
} {
  const clamped = Math.max(0, Math.min(durationMs, maxMs));
  return {
    elapsedSeconds: Math.floor(clamped / 1000),
    remainingSeconds: Math.ceil((maxMs - clamped) / 1000),
    reachedMax: durationMs >= maxMs,
  };
}
