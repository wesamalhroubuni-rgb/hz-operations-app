/**
 * The LLM provider interface (reusable platform component, Phase 7, ADR-0010).
 *
 * CONTRACT FILE: no implementation. Implementations: `AnthropicLlmProvider` (the official
 * `@anthropic-ai/sdk`, model from `AI_LLM_MODEL`) and `FakeLlmProvider` (deterministic, no
 * network; used in tests and whenever the key is missing outside production). Selected by the
 * provider registry from `AI_PROVIDER` (see `src/config/env.ts`) and bound under `LLM_PROVIDER`.
 *
 * A provider makes ONE request and reports what happened. It does not retry (the SDK's
 * `maxRetries` is 0), validate against a schema, trace, or apply limits: the runner does.
 */
import type { AiProviderInfo } from './ai-types';

/** One part of a message. Images go to the model as base64 (Claude vision). */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png'; data: Uint8Array };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContentPart[];
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxOutputTokens: number;
  /**
   * `json_schema`: the answer must be JSON matching `schema`, a JSON Schema in the subset
   * structured outputs accept (`toStructuredOutputJsonSchema` in @ops/shared). The Anthropic
   * adapter sends it as `output_config: { format: { type: 'json_schema', schema } }`.
   */
  responseFormat:
    { type: 'text' } | { type: 'json_schema'; name: string; schema: Record<string, unknown> };
}

export interface LlmResponse {
  /** The concatenated text blocks (the JSON text for `json_schema`). */
  text: string;
  /** `end`: finished; `max_tokens`: cut off (the runner treats it as invalid output). */
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'other';
  usage: { inputTokens: number; outputTokens: number };
  /** The model that answered (may differ from the requested one after a server-side fallback). */
  model: string;
  /** The provider's request id, for support; stored in the trace's error code on failure only. */
  requestId: string | null;
}

export interface LlmProvider {
  readonly info: AiProviderInfo;
  /**
   * One request. Rejects with an `AiProviderError` for a provider or network failure and when
   * `signal` aborts (code `timeout`).
   */
  generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
  /** Estimated cost in US dollars from the code's price table, or null for an unknown model. */
  estimateCostUsd(
    usage: { inputTokens: number; outputTokens: number },
    model: string,
  ): number | null;
}

/**
 * A provider failure in a form the runner can trace without leaking anything: `code` is short
 * and machine-readable (`timeout`, `network`, `http_401`, `http_429`, `http_529`,
 * `input_rejected`), `message` never contains a key, a prompt or user data.
 */
export class AiProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export const LLM_PROVIDER = Symbol('platform.llmProvider');
