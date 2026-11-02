import {
  smartCaptureConfidenceSchema,
  smartCaptureFailureReasonSchema,
  smartCaptureProposalSchema,
  SUPPORTED_LOCALES,
  type SmartCapture,
  type SmartCaptureConfidence,
  type SmartCaptureFailureReason,
  type SmartCaptureProposal,
} from '@ops/shared';
import type { SmartCapture as SmartCaptureRow } from '../../../generated/prisma/client';
import { iso, isoOrNull } from '../../common/db';

/** The stored context, read defensively (the column is JSON). */
export interface StoredCaptureContext {
  taskId: string | null;
  siteId: string | null;
  logTypeId: string | null;
  capturedAt: string;
  languageHint: SmartCapture['context']['languageHint'];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function contextOf(
  row: Pick<SmartCaptureRow, 'context' | 'createdAt'>,
): StoredCaptureContext {
  const raw =
    typeof row.context === 'object' && row.context !== null && !Array.isArray(row.context)
      ? (row.context as Record<string, unknown>)
      : {};
  const hint = stringOrNull(raw.languageHint);
  return {
    taskId: stringOrNull(raw.taskId),
    siteId: stringOrNull(raw.siteId),
    logTypeId: stringOrNull(raw.logTypeId),
    capturedAt: stringOrNull(raw.capturedAt) ?? iso(row.createdAt),
    languageHint:
      hint !== null && (SUPPORTED_LOCALES as readonly string[]).includes(hint)
        ? (hint as SmartCapture['context']['languageHint'])
        : null,
  };
}

export function proposalOf(row: Pick<SmartCaptureRow, 'proposal'>): SmartCaptureProposal | null {
  const parsed = smartCaptureProposalSchema.safeParse(row.proposal);
  return parsed.success ? parsed.data : null;
}

function confidenceOf(row: Pick<SmartCaptureRow, 'confidence'>): SmartCaptureConfidence | null {
  const parsed = smartCaptureConfidenceSchema.safeParse(row.confidence);
  return parsed.success ? parsed.data : null;
}

function failureReasonOf(
  row: Pick<SmartCaptureRow, 'failureReason'>,
): SmartCaptureFailureReason | null {
  const parsed = smartCaptureFailureReasonSchema.safeParse(row.failureReason);
  return parsed.success ? parsed.data : null;
}

/** A capture as its worker sees it. Never the storage key, the model or prompt details. */
export function toSmartCapture(row: SmartCaptureRow): SmartCapture {
  return {
    id: row.id,
    organizationId: row.organizationId,
    clientId: row.clientId,
    workerId: row.workerId,
    inputKind: row.inputKind,
    status: row.status,
    failureReason: failureReasonOf(row),
    context: contextOf(row),
    transcript: row.transcript,
    detectedLanguage: row.detectedLanguage,
    proposal: proposalOf(row),
    confidence: confidenceOf(row),
    workLogId: row.workLogId,
    inputPurged: row.inputPurgedAt !== null,
    processedAt: isoOrNull(row.processedAt),
    decidedAt: isoOrNull(row.decidedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * What the audit log and the outbox record of a capture (ADR-0010 section 3): ids, status,
 * input kind, failure reason, trace ids and work-log id. Never the transcript, the proposal,
 * the context or the storage key: the audit log is append-only and would keep them forever.
 */
export function captureRecordOf(row: SmartCaptureRow): Record<string, unknown> {
  return {
    id: row.id,
    organizationId: row.organizationId,
    clientId: row.clientId,
    workerId: row.workerId,
    inputKind: row.inputKind,
    status: row.status,
    failureReason: row.failureReason,
    traceIds: row.traceIds,
    workLogId: row.workLogId,
    inputPurged: row.inputPurgedAt !== null,
    processedAt: isoOrNull(row.processedAt),
    decidedAt: isoOrNull(row.decidedAt),
    createdAt: iso(row.createdAt),
  };
}
