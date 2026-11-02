import {
  compareWithProposal,
  type AiWorkLogMetadata,
  type SmartCaptureProposal,
} from '@ops/shared';
import type { SmartCapture as SmartCaptureRow } from '../../../generated/prisma/client';
import { ApiException } from '../../../platform/http';
import type { ChangeRecorder } from '../../common/change-recorder';
import type { Db } from '../../common/db';
import { captureRecordOf, proposalOf } from './smart-capture.mapper';

// Confirming a smart capture IS creating the work log (ADR-0010 section 6): `POST /work-logs`
// with `source: 'ai_assisted'` and `aiProposalId`. The work-log service calls these two steps
// inside its own transaction, so the log, its `aiMetadata` and the capture's `confirmed` state
// commit (and are audited) together.

/** The proposal of a capture that ended `failed`: nothing proposed, every filled field is added. */
const EMPTY_PROPOSAL: SmartCaptureProposal = {
  logTypeId: null,
  taskId: null,
  siteId: null,
  text: null,
  customFields: {},
  occurredAt: null,
};

export interface PreparedConfirmation {
  capture: SmartCaptureRow;
  aiMetadata: AiWorkLogMetadata;
}

/** What the worker submitted, after the server's own adjustments (dropped links, validation). */
export interface SubmittedLog {
  logTypeId: string | null;
  taskId: string | null;
  siteId: string | null;
  text: string | null;
  occurredAt: string;
  customFields: Record<string, unknown>;
}

function notConfirmable(captureId: string, message: string): ApiException {
  return ApiException.unprocessable(message, [
    { path: 'aiProposalId', message: `Smart capture ${captureId} ${message}` },
  ]);
}

/**
 * Step 1, before the log is written: locks the capture and checks that it is the author's own
 * and `proposed` or `failed` (422 otherwise, the same for a missing one or somebody else's);
 * already confirmed by another log is a 409 `conflict`. Returns the `aiMetadata` to store,
 * written by the API alone: the capture and trace ids, the model and prompt of the extraction,
 * and which proposed fields the worker kept, changed or added.
 */
export async function prepareConfirmation(
  tx: Db,
  input: { organizationId: string; authorId: string; captureId: string; submitted: SubmittedLog },
): Promise<PreparedConfirmation> {
  const { organizationId, authorId, captureId } = input;
  await tx.$executeRaw`SELECT 1 FROM "SmartCapture" WHERE "id" = ${captureId}::uuid FOR UPDATE`;
  const capture = await tx.smartCapture.findFirst({ where: { id: captureId, organizationId } });
  if (!capture || capture.workerId !== authorId) {
    throw notConfirmable(captureId, 'is not one of your smart captures');
  }
  if (capture.status === 'confirmed') {
    throw ApiException.conflict(
      `Smart capture ${captureId} has already been confirmed by another work log`,
      [{ path: 'aiProposalId', message: 'is already confirmed' }],
    );
  }
  if (capture.status !== 'proposed' && capture.status !== 'failed') {
    throw notConfirmable(captureId, `cannot be confirmed while it is ${capture.status}`);
  }
  const extraction = await tx.aiTrace.findFirst({
    where: { id: { in: capture.traceIds }, feature: 'capture_extraction', status: 'ok' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { model: true, promptId: true, promptVersion: true },
  });
  const proposal = proposalOf(capture) ?? EMPTY_PROPOSAL;
  const compared = compareWithProposal(proposal, input.submitted);
  return {
    capture,
    aiMetadata: {
      captureId: capture.id,
      inputKind: capture.inputKind,
      traceIds: [...capture.traceIds],
      model: extraction?.model ?? null,
      promptId: extraction?.promptId ?? null,
      promptVersion: extraction?.promptVersion ?? null,
      ...compared,
    },
  };
}

/** Step 2, after the log is written: the capture becomes `confirmed` with the log's id. */
export async function markConfirmed(
  tx: Db,
  changes: ChangeRecorder,
  prepared: PreparedConfirmation,
  workLogId: string,
  now: Date,
): Promise<void> {
  const { capture } = prepared;
  const after = await tx.smartCapture.update({
    where: { id: capture.id },
    data: { status: 'confirmed', workLogId, decidedAt: now, processingUntil: null },
  });
  await changes.record(tx, {
    organizationId: capture.organizationId,
    entityType: 'smart_capture',
    verb: 'confirmed',
    entityId: capture.id,
    before: captureRecordOf(capture),
    after: captureRecordOf(after),
  });
}
