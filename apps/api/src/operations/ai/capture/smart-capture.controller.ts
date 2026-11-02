import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  createSmartCaptureSchema,
  idSchema,
  listSmartCapturesQuerySchema,
  smartCaptureListSchema,
  smartCaptureSchema,
  smartCaptureStartedSchema,
  type CreateSmartCapture,
  type ListSmartCapturesQuery,
  type Paginated,
  type SmartCapture,
  type SmartCaptureStarted,
} from '@ops/shared';
import { Policy } from '../../../platform/authz';
import { ApiDocs, toOpenApiSchema, ZodPipe } from '../../../platform/http';
import { Idempotent } from '../../../platform/idempotency';
import { SmartCaptureService } from './smart-capture.service';

/** The part of the HTTP response this controller touches. */
interface StatusSetter {
  status(code: number): unknown;
}

const OWN_ONLY =
  'Only your own captures: anybody else’s answers 404, whatever your role. Nothing is saved as ' +
  'a work log until you confirm it with `POST /work-logs` (`source: ai_assisted`, ' +
  '`aiProposalId`).';

const AI_REFUSALS =
  '403 `ai_disabled` when the organization switched smart capture off; 429 ' +
  '`ai_limit_reached` when its daily AI limit is used up (fill in by hand); 429 ' +
  '`rate_limited` with `Retry-After` for too many AI calls in a minute; 503 `ai_unavailable` ' +
  'when the AI provider failed (the capture stays `pending`; retry later).';

const AI_ERRORS = [
  HttpStatus.FORBIDDEN,
  HttpStatus.NOT_FOUND,
  HttpStatus.CONFLICT,
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.SERVICE_UNAVAILABLE,
];

/**
 * Smart capture (Phase 7, ADR-0010 section 6): a voice note, photo or text becomes a proposed
 * work log the worker reviews. Every route needs `ai_capture.use`.
 */
@ApiTags('ai')
@Controller('ai/capture')
export class SmartCaptureController {
  constructor(private readonly captures: SmartCaptureService) {}

  @Post()
  @Policy('ai_capture.use')
  @Idempotent()
  @ApiDocs({
    summary: 'Start a smart capture (idempotent on clientId)',
    description:
      'A `text` capture is processed at once and answered `proposed` or `failed`. A `voice` ' +
      'or `photo` capture answers `awaiting_upload` with `upload`: PUT exactly `sizeBytes` ' +
      'bytes there with the given headers, then call `POST /ai/capture/{id}/process`. The same ' +
      '`clientId` again answers 200 with the existing capture (a fresh `upload` while it waits ' +
      `for its bytes); a clientId used by somebody else is a 409. ${AI_REFUSALS} ${OWN_ONLY}`,
    body: createSmartCaptureSchema,
    response: smartCaptureStartedSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.BAD_REQUEST, ...AI_ERRORS],
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The caller already had a capture with this clientId; it is returned.',
    schema: toOpenApiSchema(smartCaptureStartedSchema, 'output'),
  })
  async create(
    @Body(new ZodPipe(createSmartCaptureSchema)) body: CreateSmartCapture,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<SmartCaptureStarted> {
    const { result, created } = await this.captures.create(body);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @Get()
  @Policy('ai_capture.use')
  @ApiDocs({
    summary: 'List your smart captures',
    description: `Newest first, optionally by status. ${OWN_ONLY}`,
    query: listSmartCapturesQuerySchema,
    response: smartCaptureListSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  list(
    @Query(new ZodPipe(listSmartCapturesQuerySchema)) query: ListSmartCapturesQuery,
  ): Promise<Paginated<SmartCapture>> {
    return this.captures.list(query);
  }

  @Get(':id')
  @Policy('ai_capture.use')
  @ApiDocs({
    summary: 'Get one of your smart captures',
    description: OWN_ONLY,
    response: smartCaptureSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<SmartCapture> {
    return this.captures.get(id);
  }

  @Post(':id/upload-url')
  @Policy('ai_capture.use')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Get a fresh upload URL for a capture',
    description:
      'While the capture is `awaiting_upload` (the earlier URL expired or the upload failed); ' +
      `409 otherwise. 403 \`ai_disabled\` when smart capture is off. ${OWN_ONLY}`,
    response: smartCaptureStartedSchema,
    errors: AI_ERRORS,
  })
  renewUpload(@Param('id', new ZodPipe(idSchema)) id: string): Promise<SmartCaptureStarted> {
    return this.captures.renewUpload(id);
  }

  // Not `@Idempotent()`: processing is idempotent by state (a repeat returns the stored result),
  // and a replayed 409 "upload first" would block the same queued item after its upload.
  @Post(':id/process')
  @Policy('ai_capture.use')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Process a capture into a proposed work log',
    description:
      'Verifies the uploaded input (a photo is decoded and re-encoded without metadata before ' +
      'anything is sent; a voice note is checked by its content and size), transcribes a voice ' +
      "note, asks the model and validates its answer against the log types' fields (one " +
      'retry). Answers `proposed` with `proposal` and `confidence`, or `failed` with ' +
      '`failureReason` (`input_unusable`, `transcription_empty`, `output_invalid`, `refused`) and ' +
      'the transcript kept: both are 200. A capture already processed, confirmed or discarded ' +
      'is returned unchanged; one being processed by another call answers 409 ' +
      '`request_in_progress`; 409 `conflict` when nothing has been uploaded yet. ' +
      `${AI_REFUSALS} ${OWN_ONLY}`,
    response: smartCaptureSchema,
    errors: AI_ERRORS,
  })
  process(@Param('id', new ZodPipe(idSchema)) id: string): Promise<SmartCapture> {
    return this.captures.process(id);
  }

  @Post(':id/discard')
  @Policy('ai_capture.use')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Discard a capture',
    description:
      'The worker does not want this proposal. Idempotent; a capture already confirmed as a ' +
      `work log is a 409. The decision is recorded on the capture and its AI traces. ${OWN_ONLY}`,
    response: smartCaptureSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  discard(@Param('id', new ZodPipe(idSchema)) id: string): Promise<SmartCapture> {
    return this.captures.discard(id);
  }
}
