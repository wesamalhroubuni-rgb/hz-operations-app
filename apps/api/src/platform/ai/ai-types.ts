/**
 * The AI platform layer's contract (reusable platform component, Phase 7, ADR-0010).
 *
 * CONTRACT FILE: types, DI tokens and rules only. The implementations (the runner, the trace
 * service, the usage limiter, the prompt loader, the provider registry, the Anthropic and OpenAI
 * adapters and the fakes) live next to it in `src/platform/ai/` and follow these signatures.
 * Operations code (`src/operations/ai/`) codes against `AiRunner` only and never calls a provider
 * directly. Nothing here imports `src/operations` (ESLint enforces it).
 *
 * Host requirements: a global `PrismaService` with the `aiTrace` table; `ConfigService` with the
 * `AI_*`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` values of `src/config/env.ts`; the host binds
 * `AI_ORGANIZATION_LIMITS` (the organization's own limits, from its settings) and contributes its
 * prompt folders under `AI_PROMPT_DIRECTORIES`.
 *
 * Rules every implementation keeps:
 * - Never log or store an API key, a transcript, a prompt with user data, or model output in a
 *   log line. Traces hold the output; logs hold ids, status, latency and error codes.
 * - Every provider call writes exactly one `AiTrace` row (also when it fails or is refused by a
 *   limit: status `limited`, no provider call made).
 * - Limits are checked BEFORE the call: per-user per-minute rate (in memory per process, key
 *   `AiCall.rateLimitKey`), then the organization's requests and estimated cost of the current
 *   UTC day, counted from `AiTrace` rows (status `limited` rows do not count), against
 *   min(environment ceiling, organization limit).
 * - One provider call is bounded by `AI_REQUEST_TIMEOUT_MS` (AbortSignal). The SDK's own retries
 *   are off; the runner makes at most ONE retry, and only for invalid output (schema mismatch,
 *   unparsable JSON, `validate` refusing, `max_tokens` cut). Provider errors and timeouts are not
 *   retried by the runner: the caller decides (smart capture answers 503 `ai_unavailable`, the
 *   summary falls back to its template). A request the provider rejects (HTTP 400, 401, 403,
 *   404, 422) is the failure `rejected`, final (no 503), and logged as an error.
 * - A refusal (`stop_reason: refusal`) is the failure `refused`, not retried.
 */
import type { ZodType } from 'zod';
import type { LlmMessage } from './llm-provider';

/** Outcome of one provider call, as stored in `AiTrace.status` (Prisma enum `AiTraceStatus`). */
export type AiTraceStatus = 'ok' | 'invalid_output' | 'failed' | 'timeout' | 'limited';

/** A human's decision on what an AI call proposed (Prisma enum `AiDecision`). */
export type AiDecision = 'confirmed' | 'discarded';

/** Which provider and model served (or would serve) a call. */
export interface AiProviderInfo {
  /** `anthropic`, `openai`, `fake`. */
  name: string;
  model: string;
  /** True for the deterministic fakes (no network). */
  fake: boolean;
}

/** A versioned prompt file, by id and version (`<id>.v<version>.md`). */
export interface PromptRef {
  id: string;
  version: number;
}

/**
 * A prompt file, loaded once and cached. File format (UTF-8 Markdown):
 *
 * ```text
 * ---
 * id: smart-capture-extract
 * version: 1
 * purpose: One line saying what the prompt is for.
 * ---
 * The system prompt. Placeholders are {{name}} (letters, digits, underscore).
 * ```
 *
 * The file name must agree with the header (`smart-capture-extract.v1.md`). A prompt is never
 * edited once used in production: a change is a new version file, and the caller names the
 * version it uses, so every trace says exactly which text produced it.
 */
export interface LoadedPrompt extends PromptRef {
  purpose: string;
  /** The text after the header, unrendered. */
  body: string;
  /** SHA-256 (hex) of the file, for the trace's input references. */
  sha256: string;
  /**
   * The body with every `{{name}}` replaced. Throws on a placeholder without a value and on a
   * value that is not used. Values are trusted text chosen by the code (names of fields, the
   * date); user text never goes through here: it goes into a message as an untrusted data block.
   */
  render(variables: Readonly<Record<string, string>>): string;
}

export interface PromptLoader {
  /** The prompt `<id>.v<version>.md` from the registered folders. Throws when missing or invalid. */
  load(id: string, version: number): LoadedPrompt;
}

/**
 * Untrusted data (a transcript, a worker's text or note, names and text read from the database)
 * is placed ONLY inside a block made by `untrustedDataBlock(name, content)` (implemented in
 * `./prompt-data.ts`): `<name>` ... `</name>` with any `<` / `>` inside `content` escaped, so the
 * content cannot close the block or open another. Every system prompt says that the contents of
 * these blocks are data to analyse, never instructions, and that they cannot change the
 * recipient, the scope, the output format or any action.
 */
export type UntrustedDataBlock = (name: string, content: string) => string;

/** The organization's own limits (null = none; the environment's ceiling applies). */
export interface AiOrganizationLimits {
  dailyRequestLimit: number | null;
  dailyCostLimitUsd: number | null;
}

/** Bound by the host: reads the organization's limits from wherever it keeps settings. */
export interface AiOrganizationLimitsResolver {
  limitsFor(organizationId: string): Promise<AiOrganizationLimits>;
}

/** What a call is about. Becomes the trace row's identifying columns. */
export interface AiCall {
  organizationId: string;
  /** Host-defined feature name (HZ: `AI_FEATURES` in @ops/shared). */
  feature: string;
  /** The user whose action caused it; null for scheduled work. */
  requestedById: string | null;
  /** Key of the per-minute rate limit (normally the user id); null = not rate limited. */
  rateLimitKey: string | null;
  /** The prompt used, or null (speech-to-text without a prompt). */
  prompt: PromptRef | null;
  /**
   * References to the input for the trace: `{ subjectType, subjectId, ...counts }`. Never
   * transcripts, user text, names, e-mail addresses, phone numbers, storage keys or URLs.
   */
  inputRefs: Readonly<Record<string, unknown>>;
}

/** Tokens, audio and estimated cost of a call (summed over the retry). */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
  /** From the code's price table; null when the model's price is unknown (counted as 0). */
  costUsd: number | null;
}

/**
 * Why a call produced no usable value.
 * - `limit_reached`: the organization's daily request or cost limit (map to 429 `ai_limit_reached`).
 * - `rate_limited`: the per-user per-minute limit (429 `rate_limited`, `retryAfterSeconds`).
 * - `unavailable`: no provider configured (production without a key), or a provider outage
 *   (network, HTTP 408, 409, 429, 5xx): worth retrying later.
 * - `rejected`: the provider refused the request itself (HTTP 400, 401, 403, 404, 422: a bad
 *   key, an unknown model, a request it will never accept). Not an outage and not worth
 *   retrying; logged as an error so an operator notices.
 * - `timeout`: the provider did not answer within `AI_REQUEST_TIMEOUT_MS`.
 * - `invalid_output`: still invalid after the one retry.
 * - `refused`: the model declined.
 * - `input_rejected`: the provider refused the input itself (unreadable audio, image too large).
 */
export type AiFailureKind =
  | 'limit_reached'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'invalid_output'
  | 'refused'
  | 'input_rejected'
  | 'rejected';

export type AiOutcome<Value> =
  | {
      ok: true;
      value: Value;
      /** The trace rows written for this outcome (2 when the retry was needed). */
      traceIds: string[];
      provider: AiProviderInfo;
      usage: AiUsage;
    }
  | {
      ok: false;
      failure: AiFailureKind;
      /** Set for `rate_limited`. */
      retryAfterSeconds?: number;
      traceIds: string[];
      provider: AiProviderInfo | null;
      /** A short machine-readable reason for logs (`schema_mismatch`, `http_529`, ...). */
      errorCode: string | null;
    };

/** A JSON answer validated against a Zod schema (the provider gets its JSON Schema form). */
export interface StructuredGenerationRequest<Value> {
  /** The rendered system prompt (`LoadedPrompt.render`). */
  system: string;
  /** User content: instructions from code plus untrusted data blocks; images for a photo. */
  messages: LlmMessage[];
  /** Validates the parsed answer; its JSON Schema subset is sent as the response format. */
  schema: ZodType<Value>;
  /** A short name of the schema for the provider (`smart_capture_proposal`). */
  schemaName: string;
  maxOutputTokens: number;
  /**
   * An extra check after the schema; a non-null answer is the reason the value is invalid and
   * triggers the one retry (the reason is added to the retry's messages).
   */
  validate?: (value: Value) => string | null;
}

/** Free text (the summary narrative). Same retry rule as structured output. */
export interface TextGenerationRequest {
  system: string;
  messages: LlmMessage[];
  maxOutputTokens: number;
  /** E.g. "every number must be one of the facts"; non-null = invalid, one retry. */
  validate?: (text: string) => string | null;
}

export interface TranscriptionRequest {
  audio: Uint8Array;
  mimeType: string;
  /** A neutral name with the right extension (`capture.m4a`); never the user's file name. */
  fileName: string;
  /** ISO 639-1 hint (`tr`, `en`, `ar`); the provider still detects the language. */
  languageHint: string | null;
  /**
   * The audio's length as the client declared it (seconds), used for usage and cost when the
   * provider does not report it (the fake's duration, ADR-0010 section 2). Optional.
   */
  durationSeconds?: number | null;
}

export interface Transcription {
  text: string;
  /** ISO 639-1 when the provider reports it. */
  language: string | null;
  durationSeconds: number | null;
}

/**
 * The one entry point of the AI layer for features. Implemented by `AiRunnerService`
 * (`./ai-runner.service.ts`); bound under `AI_RUNNER`. Never throws for a provider, limit or
 * output problem (those are `ok: false` outcomes); throws only for programming errors (an
 * unknown prompt) and database errors.
 */
export interface AiRunner {
  /** The providers in force; null when a kind is unavailable (production without its key). */
  providers(): { llm: AiProviderInfo | null; speechToText: AiProviderInfo | null };
  generateStructured<Value>(
    call: AiCall,
    request: StructuredGenerationRequest<Value>,
  ): Promise<AiOutcome<Value>>;
  generateText(call: AiCall, request: TextGenerationRequest): Promise<AiOutcome<string>>;
  transcribe(call: AiCall, request: TranscriptionRequest): Promise<AiOutcome<Transcription>>;
  /**
   * Stamps the human decision on the traces of a proposal (who, when, confirmed or discarded).
   * Idempotent; a trace already decided keeps its first decision.
   */
  recordDecision(
    traceIds: readonly string[],
    decision: AiDecision,
    decidedById: string,
    decidedAt: Date,
  ): Promise<void>;
}

/** One day of usage, per feature, provider and model (UTC days). For `GET /ai/usage`. */
export interface AiUsageRow {
  day: string;
  feature: string;
  provider: string;
  model: string;
  requests: number;
  ok: number;
  invalidOutput: number;
  failed: number;
  timeout: number;
  limited: number;
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
  costUsd: number;
}

/** Reads the trace table for the usage report and the limits. Implemented by `AiTraceService`. */
export interface AiUsageReader {
  /** Rows of [fromDay, toDay] (inclusive UTC days, `YYYY-MM-DD`), newest day first. */
  usage(organizationId: string, fromDay: string, toDay: string): Promise<AiUsageRow[]>;
  /** Requests (status not `limited`) and estimated cost of the organization's current UTC day. */
  today(organizationId: string, now: Date): Promise<{ requests: number; costUsd: number }>;
}

export const AI_RUNNER = Symbol('platform.aiRunner');
export const AI_USAGE_READER = Symbol('platform.aiUsageReader');
export const PROMPT_LOADER = Symbol('platform.promptLoader');
/** Folders (absolute paths) holding `<id>.v<N>.md` prompt files; an array, contributed by the host. */
export const AI_PROMPT_DIRECTORIES = Symbol('platform.aiPromptDirectories');
/** Bound by the host to an `AiOrganizationLimitsResolver`. */
export const AI_ORGANIZATION_LIMITS = Symbol('platform.aiOrganizationLimits');
