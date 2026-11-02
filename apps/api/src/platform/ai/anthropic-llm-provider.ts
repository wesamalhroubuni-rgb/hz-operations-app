import Anthropic from '@anthropic-ai/sdk';
import type { AiProviderInfo } from './ai-types';
import { estimateTokenCostUsd } from './ai-prices';
import {
  AiProviderError,
  type LlmContentPart,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from './llm-provider';

/** The beta that enables the server-side refusal fallback (`fallbacks: 'default'`). */
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

export interface AnthropicLlmOptions {
  /**
   * Send the server-side refusal fallback (`fallbacks: 'default'` and its beta). From
   * `AI_ANTHROPIC_REFUSAL_FALLBACK`, off by default until checked with a real key.
   */
  refusalFallback?: boolean;
}

/** The part of the SDK client the adapter uses (tests pass a stub). */
export interface AnthropicMessagesClient {
  beta: {
    messages: {
      create(
        params: CreateParams,
        options?: { signal?: AbortSignal; maxRetries?: number },
      ): PromiseLike<BetaMessage>;
    };
  };
}

/**
 * Models that take `output_config.effort` (Claude 4.5 Opus and later generations). Older or
 * unknown models get no effort setting rather than a 400.
 */
export function supportsEffort(model: string): boolean {
  return (
    /^claude-(opus|sonnet|haiku|fable|mythos)-[5-9]/.test(model) ||
    /^claude-opus-4-[5-9]/.test(model) ||
    /^claude-sonnet-4-6/.test(model)
  );
}

function contentOf(part: LlmContentPart): Anthropic.Beta.Messages.BetaContentBlockParam {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: part.mediaType,
      data: Buffer.from(part.data.buffer, part.data.byteOffset, part.data.byteLength).toString(
        'base64',
      ),
    },
  };
}

function stopReasonOf(reason: BetaMessage['stop_reason']): LlmResponse['stopReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/**
 * Maps an SDK failure to an `AiProviderError` whose message carries nothing from the request or
 * the response body (no key, no prompt, no user data).
 */
export function anthropicErrorOf(error: unknown, signal: AbortSignal): AiProviderError {
  if (error instanceof AiProviderError) {
    return error;
  }
  if (
    signal.aborted ||
    error instanceof Anthropic.APIUserAbortError ||
    error instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new AiProviderError('timeout', 'The Anthropic request timed out');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiProviderError('network', 'Anthropic could not be reached');
  }
  if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
    if (error.status === 413) {
      return new AiProviderError('input_rejected', 'Anthropic refused the input as too large');
    }
    return new AiProviderError(`http_${error.status}`, `Anthropic answered HTTP ${error.status}`);
  }
  return new AiProviderError('provider_error', 'The Anthropic request failed');
}

/**
 * Claude through the official SDK (ADR-0010 section 2). One request per call: the SDK's own
 * retries are off and the runner's timeout arrives as the abort signal. Structured output goes
 * as `output_config.format` (json_schema); effort is `low` (short extraction and narratives);
 * when `refusalFallback` is on, refusals are retried server-side on Anthropic's recommended model
 * (`fallbacks: 'default'`); the model that really answered is reported.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly info: AiProviderInfo;
  private readonly client: AnthropicMessagesClient;

  constructor(
    apiKey: string,
    private readonly model: string,
    client?: AnthropicMessagesClient,
    private readonly options: AnthropicLlmOptions = {},
  ) {
    this.info = { name: 'anthropic', model, fake: false };
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 0 });
  }

  /** The request body for `request` (exported for the adapter's tests). */
  buildParams(request: LlmRequest): CreateParams {
    const outputConfig: Anthropic.Beta.Messages.BetaOutputConfig = {};
    if (supportsEffort(this.model)) {
      outputConfig.effort = 'low';
    }
    if (request.responseFormat.type === 'json_schema') {
      outputConfig.format = { type: 'json_schema', schema: request.responseFormat.schema };
    }
    return {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content.map(contentOf),
      })),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(this.options.refusalFallback
        ? { fallbacks: 'default' as const, betas: [SERVER_SIDE_FALLBACK_BETA] }
        : {}),
    };
  }

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    let message: BetaMessage;
    try {
      message = await this.client.beta.messages.create(this.buildParams(request), {
        signal,
        maxRetries: 0,
      });
    } catch (error) {
      throw anthropicErrorOf(error, signal);
    }
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    const requestId = (message as BetaMessage & { _request_id?: string | null })._request_id;
    return {
      text,
      stopReason: stopReasonOf(message.stop_reason),
      usage: {
        inputTokens:
          (message.usage.input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens ?? 0,
      },
      model: message.model || this.model,
      requestId: requestId ?? null,
    };
  }

  estimateCostUsd(usage: { inputTokens: number; outputTokens: number }, model: string) {
    return estimateTokenCostUsd(model, usage);
  }
}
