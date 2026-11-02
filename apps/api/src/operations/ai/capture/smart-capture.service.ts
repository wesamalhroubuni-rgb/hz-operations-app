import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  aiSettingsOf,
  AI_CAPTURE_MAX_AUDIO_BYTES,
  interpretCaptureOutput,
  type AiCaptureAudioMimeType,
  type AttachmentMimeType,
  type CreateSmartCapture,
  type ListSmartCapturesQuery,
  type Paginated,
  type SmartCapture,
  type SmartCaptureConfidence,
  type SmartCaptureFailureReason,
  type SmartCaptureProposal,
  type SmartCaptureStarted,
  type SmartCaptureStatus,
} from '@ops/shared';
import { Prisma, type SmartCapture as SmartCaptureRow } from '../../../generated/prisma/client';
import {
  AI_RUNNER,
  AI_SETTINGS,
  PROMPT_LOADER,
  type AiCall,
  type AiRunner,
  type AiSettings,
  type PromptLoader,
  type PromptRef,
} from '../../../platform/ai';
import {
  RATE_LIMITER,
  type RateLimiter,
  type RateLimitRule,
} from '../../../platform/auth/rate-limiter';
import { ApiException, pageArgs, paginated } from '../../../platform/http';
import { ConcurrencyLimitTimeoutError } from '../../../platform/storage/concurrency';
import {
  FILE_STORAGE,
  StorageUnavailableError,
  StoredFileTooLargeError,
  type FileStorage,
  type UploadTarget,
} from '../../../platform/storage/file-storage';
import { ImageProcessor } from '../../../platform/storage/images';
import { STORAGE_SETTINGS, type StorageSettings } from '../../../platform/storage/storage-settings';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AccessClock,
  AccessService,
  authorOf,
  siteVisibilityWhere,
  taskVisibilityWhere,
  type AccessContext,
} from '../../access';
import { ChangeRecorder } from '../../common/change-recorder';
import { isUniqueViolation, type Db } from '../../common/db';
import { loadTimeZone } from '../../common/org-time-zone';
import { fieldsOf } from '../../log-types/log-types.service';
import { checkAudio, neutralAudioFileName } from './audio-check';
import { captureFailureOutcome } from './capture-failures';
import {
  buildCaptureOffer,
  captureMessages,
  prioritise,
  type CaptureModelInput,
  type CheckedContext,
  type OfferedLogType,
  type OfferedSite,
  type OfferedTask,
} from './capture-offer';
import { captureRecordOf, contextOf, toSmartCapture } from './smart-capture.mapper';

/** The prompt of the extraction (`prompts/smart-capture-extract.v1.md`). */
export const CAPTURE_EXTRACT_PROMPT: PromptRef = { id: 'smart-capture-extract', version: 1 };

/** Room for the answer (and the model's thinking, which this model cannot turn off). */
const EXTRACTION_MAX_OUTPUT_TOKENS = 4096;

/** How many of the worker's latest logs decide the "recently used" log types and sites. */
const RECENT_LOGS = 50;
/** Upper bounds of what is loaded before the caps of the offer apply. */
const LOAD_LOG_TYPES = 200;
const LOAD_TASKS = 100;
const LOAD_SITES = 500;

/** Statuses that are an end result: processing them again returns them unchanged. */
const SETTLED: readonly SmartCaptureStatus[] = ['proposed', 'failed', 'confirmed', 'discarded'];

/** Per-user limits on the steps that do not call the AI (the AI calls have their own). */
export const CAPTURE_RATE_LIMITS = {
  create: { limit: 60, windowSeconds: 600 },
  renew: { limit: 60, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;

/** The storage key of a capture's input: chosen by the API, never by the client (ADR-0010). */
export function captureStorageKey(organizationId: string, captureId: string): string {
  return `ai-captures/${organizationId}/${captureId}`;
}

/** `YYYY-MM-DD HH:mm` of an instant in a time zone (for the prompt). */
export function localDateTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

function wire(target: UploadTarget): SmartCaptureStarted['upload'] {
  return {
    url: target.url,
    method: target.method,
    headers: target.headers,
    expiresAt: target.expiresAt.toISOString(),
  };
}

/** The end of one processing attempt. */
type ProcessResult =
  | {
      kind: 'proposed';
      proposal: SmartCaptureProposal;
      confidence: SmartCaptureConfidence;
      transcript: string | null;
      detectedLanguage: string | null;
      traceIds: string[];
    }
  | {
      kind: 'failed';
      reason: SmartCaptureFailureReason;
      transcript: string | null;
      detectedLanguage: string | null;
      traceIds: string[];
    }
  | {
      kind: 'release';
      error: ApiException;
      transcript: string | null;
      detectedLanguage: string | null;
      traceIds: string[];
    };

/**
 * Smart capture (Phase 7, ADR-0010 section 6): a worker's voice note, photo or text becomes a
 * PROPOSED work log. Only the capturing worker ever sees a capture (others: 404). Nothing here
 * creates a work log: the worker confirms with the ordinary `POST /work-logs`
 * (`source: 'ai_assisted'`, `aiProposalId`), see `capture-confirmation.ts`.
 *
 * Writes follow the usual pattern (one transaction, `ChangeRecorder.record`) for every state a
 * worker can see: `created`, `processed` (`proposed` or `failed`), `discarded`. The processing
 * lease (`processing` + `processingUntil`) and its release back to `pending` after a provider
 * failure are a technical lock, not a decision, and are not recorded. Audit and outbox carry
 * ids and states only, never the transcript or the proposal (`captureRecordOf`).
 */
@Injectable()
export class SmartCaptureService {
  private readonly logger = new Logger('SmartCapture');

  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
    private readonly clock: AccessClock,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(STORAGE_SETTINGS) private readonly storageSettings: StorageSettings,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    private readonly images: ImageProcessor,
    @Inject(AI_RUNNER) private readonly runner: AiRunner,
    @Inject(PROMPT_LOADER) private readonly prompts: PromptLoader,
    @Inject(AI_SETTINGS) private readonly aiSettings: AiSettings,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------------------------------

  async list(query: ListSmartCapturesQuery): Promise<Paginated<SmartCapture>> {
    const context = await this.access.context();
    const where: Prisma.SmartCaptureWhereInput = {
      organizationId: context.organizationId,
      workerId: context.userId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.smartCapture.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(query),
      }),
      this.prisma.smartCapture.count({ where }),
    ]);
    return paginated(rows.map(toSmartCapture), total, query);
  }

  async get(id: string): Promise<SmartCapture> {
    const context = await this.access.context();
    return toSmartCapture(await this.findOwn(this.prisma, context, id));
  }

  // ------------------------------------------------------------------------------------------
  // Create, upload URL
  // ------------------------------------------------------------------------------------------

  /**
   * Step 1. Idempotent on `clientId`: the caller's capture with that clientId is returned
   * (`created: false`) before any other check, with a fresh upload target while it waits for
   * its bytes; somebody else's clientId is a 409. A text capture is processed at once.
   */
  async create(
    input: CreateSmartCapture,
  ): Promise<{ result: SmartCaptureStarted; created: boolean }> {
    const context = await this.access.context();
    const { organizationId } = context;
    const workerId = authorOf(context);
    const repeated = await this.findByClientId(context, input.clientId);
    if (repeated) {
      return { result: await this.started(repeated), created: false };
    }
    await this.limit('create', context);
    await this.assertEnabled(this.prisma, organizationId);
    if (input.kind === 'photo' && input.sizeBytes > this.storageSettings.uploadMaxBytes) {
      const maxBytes = this.storageSettings.uploadMaxBytes;
      throw ApiException.validation(
        [{ path: 'sizeBytes', message: `must be at most ${maxBytes} bytes` }],
        `The photo is too large: the limit is ${maxBytes} bytes`,
      );
    }
    if (input.kind !== 'text') {
      // Nothing is created while the storage is down: the client gets 503 and retries.
      await this.storageCall(() => this.storage.assertAvailable());
    }
    const storedContext = {
      taskId: input.context.taskId ?? null,
      siteId: input.context.siteId ?? null,
      logTypeId: input.context.logTypeId ?? null,
      capturedAt: input.context.capturedAt,
      languageHint: input.context.languageHint ?? null,
    };
    let row: SmartCaptureRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.smartCapture.create({
          data: {
            organizationId,
            clientId: input.clientId,
            workerId,
            inputKind: input.kind,
            status: input.kind === 'text' ? 'pending' : 'awaiting_upload',
            context: storedContext,
            transcript:
              input.kind === 'text'
                ? input.text
                : input.kind === 'photo'
                  ? (input.note ?? null)
                  : null,
            inputMimeType: input.kind === 'text' ? null : input.mimeType,
            inputSizeBytes: input.kind === 'text' ? null : input.sizeBytes,
            inputDurationMs: input.kind === 'voice' ? input.durationMs : null,
          },
        });
        const withKey =
          input.kind === 'text'
            ? created
            : await tx.smartCapture.update({
                where: { id: created.id },
                data: { inputStorageKey: captureStorageKey(organizationId, created.id) },
              });
        await this.changes.record(tx, {
          organizationId,
          entityType: 'smart_capture',
          verb: 'created',
          entityId: withKey.id,
          after: captureRecordOf(withKey),
        });
        return withKey;
      });
    } catch (error) {
      // The same create sent twice at once: the other one won the unique (organizationId,
      // clientId) index. Answer as for a repeat.
      if (isUniqueViolation(error)) {
        const winner = await this.findByClientId(context, input.clientId);
        if (winner) {
          return { result: await this.started(winner), created: false };
        }
      }
      throw error;
    }
    if (row.inputKind === 'text') {
      return {
        result: { capture: toSmartCapture(await this.processRow(context, row)), upload: null },
        created: true,
      };
    }
    return {
      result: { capture: toSmartCapture(row), upload: wire(await this.uploadTarget(row)) },
      created: true,
    };
  }

  /** A fresh upload URL while the capture waits for its bytes (409 otherwise). */
  async renewUpload(id: string): Promise<SmartCaptureStarted> {
    const context = await this.access.context();
    await this.limit('renew', context);
    const row = await this.findOwn(this.prisma, context, id);
    await this.assertEnabled(this.prisma, context.organizationId);
    if (row.status !== 'awaiting_upload') {
      throw ApiException.conflict(`Smart capture ${id} does not wait for an upload`);
    }
    return { capture: toSmartCapture(row), upload: wire(await this.uploadTarget(row)) };
  }

  // ------------------------------------------------------------------------------------------
  // Process
  // ------------------------------------------------------------------------------------------

  /**
   * Step 2: verifies the input, transcribes a voice note, asks the model and stores `proposed`
   * or `failed`. A capture already processed (or confirmed, or discarded) is returned
   * unchanged; one being processed by another call answers 409 `request_in_progress`.
   */
  async process(id: string): Promise<SmartCapture> {
    const context = await this.access.context();
    const row = await this.findOwn(this.prisma, context, id);
    if (SETTLED.includes(row.status)) {
      return toSmartCapture(row);
    }
    await this.assertEnabled(this.prisma, context.organizationId);
    return toSmartCapture(await this.processRow(context, row));
  }

  private leaseMs(): number {
    // Transcription, extraction and its one retry, plus the verification of the input.
    return 3 * this.aiSettings.requestTimeoutMs + 15_000;
  }

  private async processRow(context: AccessContext, row: SmartCaptureRow): Promise<SmartCaptureRow> {
    if (row.status === 'awaiting_upload') {
      const key = row.inputStorageKey;
      const stored = key ? await this.storageCall(() => this.storage.stat(key)) : null;
      if (!stored) {
        throw ApiException.conflict(
          'The input has not been received yet: upload it to the upload URL first',
        );
      }
    }
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs());
    const { count } = await this.prisma.smartCapture.updateMany({
      where: {
        id: row.id,
        OR: [
          { status: { in: ['awaiting_upload', 'pending'] } },
          { status: 'processing', processingUntil: { lt: now } },
        ],
      },
      data: { status: 'processing', processingUntil: leaseUntil },
    });
    if (count === 0) {
      const current = await this.prisma.smartCapture.findUniqueOrThrow({ where: { id: row.id } });
      if (SETTLED.includes(current.status)) {
        return current;
      }
      throw ApiException.of(
        'request_in_progress',
        `Smart capture ${row.id} is being processed; try again shortly`,
      );
    }
    let result: ProcessResult;
    try {
      result = await this.run(context, row);
    } catch (error) {
      await this.release(row, leaseUntil, {
        transcript: row.transcript,
        detectedLanguage: row.detectedLanguage,
        traceIds: [],
      });
      throw error;
    }
    if (result.kind === 'release') {
      await this.release(row, leaseUntil, result);
      throw result.error;
    }
    return this.settle(row, leaseUntil, result);
  }

  /** Back to `pending` (kept for a later try), keeping what was learned and traced. */
  private async release(
    row: SmartCaptureRow,
    leaseUntil: Date,
    learned: { transcript: string | null; detectedLanguage: string | null; traceIds: string[] },
  ): Promise<void> {
    await this.prisma.smartCapture.updateMany({
      where: { id: row.id, status: 'processing', processingUntil: leaseUntil },
      data: {
        status: 'pending',
        processingUntil: null,
        transcript: learned.transcript,
        detectedLanguage: learned.detectedLanguage,
        traceIds: [...row.traceIds, ...learned.traceIds],
      },
    });
  }

  /** Stores the end result, unless the lease was lost (discarded meanwhile, or taken over). */
  private settle(
    row: SmartCaptureRow,
    leaseUntil: Date,
    result: Exclude<ProcessResult, { kind: 'release' }>,
  ): Promise<SmartCaptureRow> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.smartCapture.updateMany({
        where: { id: row.id, status: 'processing', processingUntil: leaseUntil },
        data: {
          status: result.kind,
          failureReason: result.kind === 'failed' ? result.reason : null,
          transcript: result.transcript,
          detectedLanguage: result.detectedLanguage,
          proposal:
            result.kind === 'proposed'
              ? (result.proposal as unknown as Prisma.InputJsonObject)
              : Prisma.DbNull,
          confidence:
            result.kind === 'proposed'
              ? (result.confidence as unknown as Prisma.InputJsonObject)
              : Prisma.DbNull,
          traceIds: [...row.traceIds, ...result.traceIds],
          processingUntil: null,
          processedAt: now,
        },
      });
      const after = await tx.smartCapture.findUniqueOrThrow({ where: { id: row.id } });
      if (count === 0) {
        return after;
      }
      await this.changes.record(tx, {
        organizationId: row.organizationId,
        entityType: 'smart_capture',
        verb: 'processed',
        entityId: row.id,
        before: captureRecordOf(row),
        after: captureRecordOf(after),
      });
      return after;
    });
  }

  /** One processing attempt. Throws only for unexpected errors and an unreachable storage. */
  private async run(context: AccessContext, row: SmartCaptureRow): Promise<ProcessResult> {
    const traceIds: string[] = [];
    let transcript = row.transcript;
    let detectedLanguage = row.detectedLanguage;
    const failed = (reason: SmartCaptureFailureReason): ProcessResult => ({
      kind: 'failed',
      reason,
      transcript,
      detectedLanguage,
      traceIds,
    });
    const fromFailure = (
      failure: Parameters<typeof captureFailureOutcome>[0],
      retryAfter?: number,
    ) => {
      const outcome = captureFailureOutcome(failure, retryAfter);
      return outcome.kind === 'fail'
        ? failed(outcome.reason)
        : ({
            kind: 'release',
            error: outcome.error,
            transcript,
            detectedLanguage,
            traceIds,
          } satisfies ProcessResult);
    };
    const stored = contextOf(row);
    const call = (
      feature: string,
      prompt: PromptRef | null,
      refs: Record<string, unknown>,
    ): AiCall => ({
      organizationId: row.organizationId,
      feature,
      requestedById: row.workerId,
      rateLimitKey: row.workerId,
      prompt,
      inputRefs: {
        subjectType: 'smart_capture',
        subjectId: row.id,
        inputKind: row.inputKind,
        ...refs,
      },
    });

    let input: CaptureModelInput;
    switch (row.inputKind) {
      case 'text':
        input = { kind: 'text', text: transcript ?? '' };
        break;
      case 'voice': {
        if (transcript === null) {
          const bytes = await this.readInput(row, AI_CAPTURE_MAX_AUDIO_BYTES);
          const mimeType = row.inputMimeType as AiCaptureAudioMimeType;
          if (bytes === null || !checkAudio(bytes, mimeType).ok) {
            return failed('input_unusable');
          }
          const heard = await this.runner.transcribe(
            call('capture_transcription', null, {
              sizeBytes: bytes.byteLength,
              durationMs: row.inputDurationMs,
            }),
            {
              audio: bytes,
              mimeType,
              fileName: neutralAudioFileName(mimeType),
              languageHint: stored.languageHint,
              durationSeconds: row.inputDurationMs === null ? null : row.inputDurationMs / 1000,
            },
          );
          traceIds.push(...heard.traceIds);
          if (!heard.ok) {
            return fromFailure(heard.failure, heard.retryAfterSeconds);
          }
          transcript = heard.value.text.trim();
          detectedLanguage = heard.value.language;
          if (transcript === '') {
            return failed('transcription_empty');
          }
        }
        input = { kind: 'voice', transcript };
        break;
      }
      case 'photo': {
        const bytes = await this.readInput(row, this.storageSettings.uploadMaxBytes);
        if (bytes === null) {
          return failed('input_unusable');
        }
        const check = await this.verifyImage(bytes, row.inputMimeType as AttachmentMimeType);
        if (!check.ok) {
          return failed('input_unusable');
        }
        // Only the re-encoded image (orientation applied, EXIF and GPS dropped) goes out.
        input = {
          kind: 'photo',
          note: transcript,
          image: { mediaType: check.image.mimeType, data: check.image.data },
        };
        break;
      }
    }

    const checked = await this.checkContext(context, stored);
    const offer = buildCaptureOffer({
      ...(await this.loadOffer(context, row.workerId, checked)),
      context: checked,
    });
    const timeZone = await loadTimeZone(this.prisma, row.organizationId);
    const capturedAt = new Date(stored.capturedAt);
    const system = this.prompts
      .load(CAPTURE_EXTRACT_PROMPT.id, CAPTURE_EXTRACT_PROMPT.version)
      .render({
        input_kind: row.inputKind,
        time_zone: timeZone,
        captured_at_local: localDateTime(capturedAt, timeZone),
        captured_at_utc: capturedAt.toISOString(),
      });
    const extracted = await this.runner.generateStructured(
      call('capture_extraction', CAPTURE_EXTRACT_PROMPT, {
        logTypes: offer.refs.logTypes.length,
        tasks: offer.refs.tasks.size,
        sites: offer.refs.sites.size,
      }),
      {
        system,
        messages: captureMessages(offer, input),
        schema: offer.schema,
        schemaName: 'smart_capture_proposal',
        maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      },
    );
    traceIds.push(...extracted.traceIds);
    if (!extracted.ok) {
      return fromFailure(extracted.failure, extracted.retryAfterSeconds);
    }
    const interpreted = interpretCaptureOutput(extracted.value, offer.refs, stored.capturedAt);
    if (interpreted.droppedFields.length > 0) {
      this.logger.log(
        `capture=${row.id} dropped ${interpreted.droppedFields.length} proposed value(s) that failed their field rule`,
      );
    }
    return {
      kind: 'proposed',
      proposal: interpreted.proposal,
      confidence: interpreted.confidence,
      transcript,
      detectedLanguage,
      traceIds,
    };
  }

  /**
   * The context hints that the worker may still use: a task or site they can see and that is
   * not archived, an active log type of the organization. Others are dropped (never an error).
   */
  private async checkContext(
    context: AccessContext,
    stored: { taskId: string | null; siteId: string | null; logTypeId: string | null },
  ): Promise<CheckedContext> {
    const { organizationId } = context;
    const [task, site, logType] = await Promise.all([
      stored.taskId
        ? this.prisma.task.findFirst({
            where: {
              id: stored.taskId,
              organizationId,
              archivedAt: null,
              AND: [taskVisibilityWhere(context) as Prisma.TaskWhereInput],
            },
            select: { id: true },
          })
        : null,
      stored.siteId
        ? this.prisma.site.findFirst({
            where: {
              id: stored.siteId,
              organizationId,
              archivedAt: null,
              AND: [siteVisibilityWhere(context) as Prisma.SiteWhereInput],
            },
            select: { id: true },
          })
        : null,
      stored.logTypeId
        ? this.prisma.logType.findFirst({
            where: { id: stored.logTypeId, organizationId, archivedAt: null },
            select: { id: true },
          })
        : null,
    ]);
    return { taskId: task?.id ?? null, siteId: site?.id ?? null, logTypeId: logType?.id ?? null };
  }

  /**
   * What the model may choose from, within the worker's visibility: active log types (the
   * context's first, then the recently used), the open tasks assigned to them (the context's
   * task first), the visible sites (the context's first, then the recently used). Names and
   * titles only; never people.
   */
  private async loadOffer(
    context: AccessContext,
    workerId: string,
    checked: CheckedContext,
  ): Promise<{ logTypes: OfferedLogType[]; tasks: OfferedTask[]; sites: OfferedSite[] }> {
    const { organizationId } = context;
    const visibleTask = taskVisibilityWhere(context) as Prisma.TaskWhereInput;
    const [logTypeRows, recent, assigned, contextTask, siteRows] = await Promise.all([
      this.prisma.logType.findMany({
        where: { organizationId, archivedAt: null },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: LOAD_LOG_TYPES,
      }),
      this.prisma.workLog.findMany({
        where: { organizationId, authorId: workerId, archivedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_LOGS,
        select: { logTypeId: true, siteId: true },
      }),
      this.prisma.task.findMany({
        where: {
          organizationId,
          archivedAt: null,
          status: { in: ['todo', 'in_progress', 'blocked'] },
          assignees: { some: { userId: workerId } },
          AND: [visibleTask],
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: LOAD_TASKS,
        select: { id: true, title: true },
      }),
      checked.taskId
        ? this.prisma.task.findFirst({
            where: { id: checked.taskId, organizationId, AND: [visibleTask] },
            select: { id: true, title: true },
          })
        : null,
      this.prisma.site.findMany({
        where: {
          organizationId,
          archivedAt: null,
          AND: [siteVisibilityWhere(context) as Prisma.SiteWhereInput],
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: LOAD_SITES,
        select: { id: true, name: true },
      }),
    ]);
    const logTypes = logTypeRows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      fields: fieldsOf(row),
    }));
    return {
      logTypes: prioritise(
        logTypes,
        [checked.logTypeId, ...recent.map((log) => log.logTypeId)],
        logTypes.length,
      ),
      tasks: prioritise(
        contextTask ? [contextTask, ...assigned] : assigned,
        [checked.taskId],
        LOAD_TASKS,
      ),
      sites: prioritise(
        siteRows,
        [checked.siteId, ...recent.map((log) => log.siteId)],
        siteRows.length,
      ),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Discard
  // ------------------------------------------------------------------------------------------

  /**
   * The worker does not want this capture. Idempotent; a confirmed capture is a 409. The
   * decision is stamped on the capture and, after the commit, on its traces.
   */
  async discard(id: string): Promise<SmartCapture> {
    const context = await this.access.context();
    const decidedById = authorOf(context);
    const now = this.clock.now();
    const { row, changed } = await this.prisma.$transaction(async (tx) => {
      const current = await this.findOwn(tx, context, id);
      if (current.status === 'discarded') {
        return { row: current, changed: false };
      }
      if (current.status === 'confirmed') {
        throw ApiException.conflict(`Smart capture ${id} was confirmed as a work log`);
      }
      const { count } = await tx.smartCapture.updateMany({
        where: { id, status: current.status },
        data: { status: 'discarded', decidedAt: now, processingUntil: null },
      });
      const after = await tx.smartCapture.findUniqueOrThrow({ where: { id } });
      if (count === 0) {
        if (after.status === 'confirmed') {
          throw ApiException.conflict(`Smart capture ${id} was confirmed as a work log`);
        }
        return { row: after, changed: false };
      }
      await this.changes.record(tx, {
        organizationId: context.organizationId,
        entityType: 'smart_capture',
        verb: 'discarded',
        entityId: id,
        before: captureRecordOf(current),
        after: captureRecordOf(after),
      });
      return { row: after, changed: true };
    });
    if (changed) {
      await this.runner
        .recordDecision(row.traceIds, 'discarded', decidedById, now)
        .catch((error: unknown) =>
          this.logger.warn(
            `capture=${id} could not stamp the decision on its traces: ${error instanceof Error ? error.name : 'error'}`,
          ),
        );
    }
    return toSmartCapture(row);
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  /** 403 `ai_disabled` unless the organization switched smart capture on. */
  private async assertEnabled(db: Db, organizationId: string): Promise<void> {
    const organization = await db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    if (!aiSettingsOf(organization?.settings).smartCaptureEnabled) {
      throw ApiException.of('ai_disabled', 'Smart capture is switched off for this organization');
    }
  }

  /** The caller's own capture; anybody else's (and a missing one) is a 404. */
  private async findOwn(db: Db, context: AccessContext, id: string): Promise<SmartCaptureRow> {
    const row = await db.smartCapture.findFirst({
      where: { id, organizationId: context.organizationId, workerId: context.userId },
    });
    if (!row) {
      throw ApiException.notFound('Smart capture', id);
    }
    return row;
  }

  /** The caller's capture with this clientId, null when unused, 409 when somebody else's. */
  private async findByClientId(
    context: AccessContext,
    clientId: string,
  ): Promise<SmartCaptureRow | null> {
    const row = await this.prisma.smartCapture.findUnique({
      where: { organizationId_clientId: { organizationId: context.organizationId, clientId } },
    });
    if (!row) {
      return null;
    }
    if (row.workerId !== context.userId) {
      throw ApiException.conflict('This clientId has already been used', [
        { path: 'clientId', message: 'is already in use' },
      ]);
    }
    return row;
  }

  /** The answer to a repeated create: the capture, with a fresh target while it waits. */
  private async started(row: SmartCaptureRow): Promise<SmartCaptureStarted> {
    if (row.status !== 'awaiting_upload') {
      return { capture: toSmartCapture(row), upload: null };
    }
    return { capture: toSmartCapture(row), upload: wire(await this.uploadTarget(row)) };
  }

  private async uploadTarget(row: SmartCaptureRow): Promise<UploadTarget> {
    const key = row.inputStorageKey;
    if (!key || !row.inputMimeType || !row.inputSizeBytes) {
      throw new Error(`Smart capture ${row.id} has no input to upload`);
    }
    await this.storageCall(() => this.storage.assertAvailable());
    return this.storageCall(() =>
      this.storage.createUploadTarget({
        storageKey: key,
        mimeType: row.inputMimeType!,
        sizeBytes: row.inputSizeBytes!,
      }),
    );
  }

  /** The uploaded input, or null when it is missing, purged or larger than allowed. */
  private async readInput(row: SmartCaptureRow, maxBytes: number): Promise<Uint8Array | null> {
    const key = row.inputStorageKey;
    if (!key || row.inputPurgedAt !== null) {
      return null;
    }
    try {
      return await this.storageCall(() => this.storage.read(key, maxBytes));
    } catch (error) {
      if (error instanceof StoredFileTooLargeError) {
        return null;
      }
      throw error;
    }
  }

  private async verifyImage(bytes: Uint8Array, mimeType: AttachmentMimeType) {
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

  /** 429 `rate_limited` (with `Retry-After`) once the caller used up the step's budget. */
  private async limit(
    step: keyof typeof CAPTURE_RATE_LIMITS,
    context: AccessContext,
  ): Promise<void> {
    const decision = await this.limiter.hit(
      `ai_capture:${step}:${context.userId}`,
      CAPTURE_RATE_LIMITS[step],
    );
    if (!decision.allowed) {
      throw ApiException.rateLimited(
        'Too many smart capture requests. Try again later.',
        decision.retryAfterSeconds,
      );
    }
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
}
