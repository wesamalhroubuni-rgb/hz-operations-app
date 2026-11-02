import { Inject, Injectable, Logger } from '@nestjs/common';
import { toStructuredOutputJsonSchema } from '@ops/shared';
import type { ZodType } from 'zod';
import { AUTH_CLOCK, type Clock } from '../auth/clock';
import { RequestContext } from '../request-context/request-context';
import { AI_SETTINGS, type AiSettings } from './ai-settings';
import { AiTraceService, type AiTraceInput } from './ai-trace.service';
import {
  PROMPT_LOADER,
  type AiCall,
  type AiDecision,
  type AiFailureKind,
  type AiOutcome,
  type AiProviderInfo,
  type AiRunner,
  type AiTraceStatus,
  type AiUsage,
  type PromptLoader,
  type StructuredGenerationRequest,
  type TextGenerationRequest,
  type Transcription,
  type TranscriptionRequest,
} from './ai-types';
import {
  AiProviderError,
  LLM_PROVIDER,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from './llm-provider';
import {
  SPEECH_TO_TEXT_PROVIDER,
  type SpeechToTextProvider,
  type SpeechToTextResponse,
} from './speech-to-text-provider';
import { AiUsageLimiter } from './usage-limiter';

/** What the runner makes of one answer: a usable value, or why it is invalid. */
type Interpretation<Value> =
  { ok: true; value: Value; output: unknown } | { ok: false; errorCode: string; reason: string };

/** At most one retry, and only for invalid output (ADR-0010 section 5). */
const MAX_ATTEMPTS = 2;

/** The note added to the retry's messages. The reason is produced by code, never by the user. */
export function retryMessage(reason: string): LlmMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `Your previous answer could not be used: ${reason} ` +
          'Answer again, following the required format exactly.',
      },
    ],
  };
}

/** A short description of why a value does not match its schema (paths and Zod messages). */
export function describeSchemaIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
) {
  const listed = issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
  const more = issues.length > 5 ? ` (and ${issues.length - 5} more)` : '';
  return `The answer does not match the required schema: ${listed.join('; ')}${more}.`;
}

/**
 * Provider answers that reject the request itself (configuration or request error, not an
 * outage). 413 stays `input_rejected`; 408, 409, 429 and 5xx stay `unavailable`.
 */
const REJECTED_HTTP_CODES: ReadonlySet<string> = new Set([
  'http_400',
  'http_401',
  'http_403',
  'http_404',
  'http_422',
]);

/** The trace status, failure kind and error code of a provider that threw. */
function providerFailure(
  error: unknown,
  signal: AbortSignal,
): { status: AiTraceStatus; failure: AiFailureKind; errorCode: string } {
  const code = error instanceof AiProviderError ? error.code : 'provider_error';
  if (signal.aborted || code === 'timeout') {
    return { status: 'timeout', failure: 'timeout', errorCode: 'timeout' };
  }
  if (code === 'input_rejected') {
    return { status: 'failed', failure: 'input_rejected', errorCode: code };
  }
  if (REJECTED_HTTP_CODES.has(code)) {
    return { status: 'failed', failure: 'rejected', errorCode: code };
  }
  return { status: 'failed', failure: 'unavailable', errorCode: code };
}

function addCost(total: number | null | undefined, cost: number | null): number | null {
  if (total === null || cost === null) {
    return null;
  }
  return Math.round(((total ?? 0) + cost) * 1_000_000) / 1_000_000;
}

/**
 * The one entry point of the AI layer (`AI_RUNNER`, ADR-0010): limits before the call, the
 * timeout, one retry for invalid output, structured-output validation, refusal handling, and
 * exactly one trace row per provider call or limit refusal. Never throws for a provider, limit
 * or output problem.
 */
@Injectable()
export class AiRunnerService implements AiRunner {
  private readonly logger = new Logger('AiRunner');

  constructor(
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider | null,
    @Inject(SPEECH_TO_TEXT_PROVIDER) private readonly speech: SpeechToTextProvider | null,
    @Inject(PROMPT_LOADER) private readonly prompts: PromptLoader,
    @Inject(AUTH_CLOCK) private readonly clock: Clock,
    private readonly traces: AiTraceService,
    private readonly limiter: AiUsageLimiter,
  ) {}

  providers() {
    return { llm: this.llm?.info ?? null, speechToText: this.speech?.info ?? null };
  }

  generateStructured<Value>(
    call: AiCall,
    request: StructuredGenerationRequest<Value>,
  ): Promise<AiOutcome<Value>> {
    const schema = toStructuredOutputJsonSchema(request.schema as ZodType);
    return this.generate<Value>(
      call,
      {
        system: request.system,
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        responseFormat: { type: 'json_schema', name: request.schemaName, schema },
      },
      (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return {
            ok: false,
            errorCode: 'unparsable_json',
            reason: 'The answer was not valid JSON.',
          };
        }
        const result = request.schema.safeParse(parsed);
        if (!result.success) {
          return {
            ok: false,
            errorCode: 'schema_mismatch',
            reason: describeSchemaIssues(result.error.issues),
          };
        }
        const rejected = request.validate?.(result.data) ?? null;
        if (rejected !== null) {
          return { ok: false, errorCode: 'validation_failed', reason: rejected };
        }
        return { ok: true, value: result.data, output: result.data };
      },
    );
  }

  generateText(call: AiCall, request: TextGenerationRequest): Promise<AiOutcome<string>> {
    return this.generate<string>(
      call,
      {
        system: request.system,
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        responseFormat: { type: 'text' },
      },
      (text) => {
        const value = text.trim();
        if (value === '') {
          return { ok: false, errorCode: 'empty_output', reason: 'The answer was empty.' };
        }
        const rejected = request.validate?.(value) ?? null;
        if (rejected !== null) {
          return { ok: false, errorCode: 'validation_failed', reason: rejected };
        }
        return { ok: true, value, output: value };
      },
    );
  }

  async transcribe(call: AiCall, request: TranscriptionRequest): Promise<AiOutcome<Transcription>> {
    const provider = this.speech;
    if (!provider) {
      return this.unavailable(call);
    }
    const inputRefs = this.inputRefsOf(call);
    const refused = await this.checkLimits(call, provider.info, inputRefs);
    if (refused) {
      return refused;
    }
    const { signal, done } = this.timeoutSignal();
    const started = Date.now();
    let response: SpeechToTextResponse;
    try {
      response = await provider.transcribe(request, signal);
    } catch (error) {
      const failed = providerFailure(error, signal);
      const traceId = await this.trace(call, provider.info, inputRefs, {
        attempt: 1,
        status: failed.status,
        errorCode: failed.errorCode,
        latencyMs: Date.now() - started,
      });
      this.reportRejected(call, provider.info, failed, traceId);
      return {
        ok: false,
        failure: failed.failure,
        traceIds: [traceId],
        provider: provider.info,
        errorCode: failed.errorCode,
      };
    } finally {
      done();
    }
    const latencyMs = Date.now() - started;
    const durationSeconds = response.durationSeconds ?? request.durationSeconds ?? null;
    const audioSeconds = durationSeconds ?? 0;
    const measuredUsage = { ...response.usage, audioSeconds };
    // A model missing from the price table (a fallback model) is estimated at the configured one's.
    const costUsd =
      provider.estimateCostUsd(measuredUsage, response.model) ??
      provider.estimateCostUsd(measuredUsage, provider.info.model);
    const value: Transcription = {
      text: response.text,
      language: response.language,
      durationSeconds,
    };
    const info = { ...provider.info, model: response.model };
    const traceId = await this.trace(call, info, inputRefs, {
      attempt: 1,
      status: 'ok',
      output: value,
      latencyMs,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      audioSeconds,
      costUsd,
    });
    return {
      ok: true,
      value,
      traceIds: [traceId],
      provider: info,
      usage: { ...response.usage, audioSeconds, costUsd },
    };
  }

  recordDecision(
    traceIds: readonly string[],
    decision: AiDecision,
    decidedById: string,
    decidedAt: Date,
  ): Promise<void> {
    return this.traces.decide(traceIds, decision, decidedById, decidedAt);
  }

  private async generate<Value>(
    call: AiCall,
    base: LlmRequest,
    interpret: (text: string) => Interpretation<Value>,
  ): Promise<AiOutcome<Value>> {
    const provider = this.llm;
    if (!provider) {
      return this.unavailable(call);
    }
    const inputRefs = this.inputRefsOf(call);
    const refused = await this.checkLimits(call, provider.info, inputRefs);
    if (refused) {
      return refused;
    }

    const traceIds: string[] = [];
    const usage: AiUsage = { inputTokens: 0, outputTokens: 0, audioSeconds: 0, costUsd: 0 };
    let retryReason: string | null = null;
    let lastErrorCode = 'invalid_output';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const messages =
        retryReason === null ? base.messages : [...base.messages, retryMessage(retryReason)];
      const { signal, done } = this.timeoutSignal();
      const started = Date.now();
      let response: LlmResponse;
      try {
        response = await provider.generate({ ...base, messages }, signal);
      } catch (error) {
        const failed = providerFailure(error, signal);
        const traceId = await this.trace(call, provider.info, inputRefs, {
          attempt,
          status: failed.status,
          errorCode: failed.errorCode,
          latencyMs: Date.now() - started,
        });
        traceIds.push(traceId);
        this.reportRejected(call, provider.info, failed, traceId);
        return {
          ok: false,
          failure: failed.failure,
          traceIds,
          provider: provider.info,
          errorCode: failed.errorCode,
        };
      } finally {
        done();
      }
      const latencyMs = Date.now() - started;
      // A model missing from the price table (a server-side fallback) is estimated at the
      // configured model's price rather than as unknown.
      const costUsd =
        provider.estimateCostUsd(response.usage, response.model) ??
        provider.estimateCostUsd(response.usage, provider.info.model);
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.costUsd = addCost(usage.costUsd, costUsd);
      const info: AiProviderInfo = { ...provider.info, model: response.model };
      const measured = {
        attempt,
        latencyMs,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd,
      };

      if (response.stopReason === 'refusal') {
        traceIds.push(
          await this.trace(call, info, inputRefs, {
            ...measured,
            status: 'failed',
            errorCode: 'refused',
          }),
        );
        return { ok: false, failure: 'refused', traceIds, provider: info, errorCode: 'refused' };
      }
      const result: Interpretation<Value> =
        response.stopReason === 'max_tokens'
          ? {
              ok: false,
              errorCode: 'max_tokens',
              reason: 'The answer was cut off at the output limit; answer more briefly.',
            }
          : interpret(response.text);
      if (result.ok) {
        traceIds.push(
          await this.trace(call, info, inputRefs, {
            ...measured,
            status: 'ok',
            output: result.output,
          }),
        );
        return { ok: true, value: result.value, traceIds, provider: info, usage };
      }
      traceIds.push(
        await this.trace(call, info, inputRefs, {
          ...measured,
          status: 'invalid_output',
          errorCode: result.errorCode,
        }),
      );
      retryReason = result.reason;
      lastErrorCode = result.errorCode;
    }
    return {
      ok: false,
      failure: 'invalid_output',
      traceIds,
      provider: provider.info,
      errorCode: lastErrorCode,
    };
  }

  /** The call's input references plus the prompt file's SHA-256 (throws for an unknown prompt). */
  private inputRefsOf(call: AiCall): Record<string, unknown> {
    if (!call.prompt) {
      return { ...call.inputRefs };
    }
    const prompt = this.prompts.load(call.prompt.id, call.prompt.version);
    return { ...call.inputRefs, promptSha256: prompt.sha256 };
  }

  /** A `limited` trace and the failure, or null when the call may go ahead. */
  private async checkLimits(
    call: AiCall,
    provider: AiProviderInfo,
    inputRefs: Record<string, unknown>,
  ): Promise<Extract<AiOutcome<never>, { ok: false }> | null> {
    const decision = await this.limiter.check(
      call.organizationId,
      call.rateLimitKey,
      this.clock.now(),
    );
    if (decision.allowed) {
      return null;
    }
    const traceId = await this.trace(call, provider, inputRefs, {
      attempt: 1,
      status: 'limited',
      errorCode: decision.errorCode,
    });
    return {
      ok: false,
      failure: decision.failure,
      ...(decision.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: decision.retryAfterSeconds }),
      traceIds: [traceId],
      provider,
      errorCode: decision.errorCode,
    };
  }

  private unavailable(call: AiCall): Extract<AiOutcome<never>, { ok: false }> {
    this.logger.warn(
      `ai feature=${call.feature} status=unavailable errorCode=no_provider ` +
        `organizationId=${call.organizationId}`,
    );
    return {
      ok: false,
      failure: 'unavailable',
      traceIds: [],
      provider: null,
      errorCode: 'no_provider',
    };
  }

  /**
   * A provider that rejects the request (bad key, unknown model, ...) will keep doing so: an
   * error line (ids and code only) so an operator notices.
   */
  private reportRejected(
    call: AiCall,
    provider: AiProviderInfo,
    failed: { failure: AiFailureKind; errorCode: string },
    traceId: string,
  ): void {
    if (failed.failure !== 'rejected') {
      return;
    }
    this.logger.error(
      `ai feature=${call.feature} status=rejected provider=${provider.name} ` +
        `model=${provider.model} errorCode=${failed.errorCode} ` +
        `organizationId=${call.organizationId} traceId=${traceId}`,
    );
  }

  /** An abort signal that fires after `AI_REQUEST_TIMEOUT_MS`; `done` clears the timer. */
  private timeoutSignal(): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);
    timer.unref?.();
    return { signal: controller.signal, done: () => clearTimeout(timer) };
  }

  private async trace(
    call: AiCall,
    provider: AiProviderInfo,
    inputRefs: Record<string, unknown>,
    facts: Partial<AiTraceInput> & Pick<AiTraceInput, 'attempt' | 'status'>,
  ): Promise<string> {
    const id = await this.traces.record({
      organizationId: call.organizationId,
      feature: call.feature,
      provider: provider.name,
      model: provider.model,
      prompt: call.prompt,
      inputRefs,
      output: null,
      errorCode: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      audioSeconds: null,
      costUsd: null,
      requestedById: call.requestedById,
      correlationId: RequestContext.correlationId(),
      createdAt: this.clock.now(),
      ...facts,
    });
    // Ids, feature, status, latency and error code only: never prompts, transcripts or output.
    const line =
      `ai feature=${call.feature} status=${facts.status} attempt=${facts.attempt} ` +
      `provider=${provider.name} model=${provider.model} ` +
      `latencyMs=${facts.latencyMs ?? '-'} errorCode=${facts.errorCode ?? '-'} traceId=${id}`;
    if (facts.status === 'ok') {
      this.logger.log(line);
    } else {
      this.logger.warn(line);
    }
    return id;
  }
}
