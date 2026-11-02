import type { AiProviderInfo } from './ai-types';
import { estimateTokenCostUsd } from './ai-prices';
import {
  AiProviderError,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from './llm-provider';
import { unescapeUntrustedText } from './prompt-data';

/** Markers the fake answers to (ADR-0010 section 2). Test-only behaviour; never in production. */
export const FAKE_LLM_MARKERS = {
  json: 'FAKE-LLM-JSON:',
  invalid: 'FAKE-LLM-INVALID',
  refuse: 'FAKE-LLM-REFUSE',
  fail: 'FAKE-LLM-FAIL',
  slow: 'FAKE-LLM-SLOW',
} as const;

export const FAKE_NARRATIVE = 'Fake narrative.';
export const FAKE_LLM_MODEL = 'fake-llm-1';

/** Token estimate of the fakes: one token per four characters, rounded up. */
export function fakeTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function userText(messages: readonly LlmMessage[]): string {
  return messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

/**
 * The text after `FAKE-LLM-JSON:` up to the end of the data block it is in (the next closing
 * tag) or the end of the text, unescaped (data blocks escape `<`, `>` and `&`).
 */
function injectedAnswer(text: string): string | null {
  const start = text.indexOf(FAKE_LLM_MARKERS.json);
  if (start < 0) {
    return null;
  }
  const rest = text.slice(start + FAKE_LLM_MARKERS.json.length);
  const close = /<\/[A-Za-z][A-Za-z0-9_-]*>/.exec(rest);
  return unescapeUntrustedText(close ? rest.slice(0, close.index) : rest).trim();
}

type JsonSchema = Record<string, unknown>;

/**
 * The smallest instance of a JSON Schema (structured-output subset): null wherever null is
 * allowed, the smallest variant of a union (so the "no log type" variant of a capture), empty
 * strings and arrays, zero, false, the first enum value or the const.
 */
export function smallestInstance(
  schema: unknown,
  root: JsonSchema = schema as JsonSchema,
): unknown {
  if (typeof schema !== 'object' || schema === null) {
    return null;
  }
  const node = schema as JsonSchema;
  if (typeof node.$ref === 'string') {
    const path = node.$ref.replace(/^#\/?/, '').split('/').filter(Boolean);
    let target: unknown = root;
    for (const segment of path) {
      target = (target as JsonSchema | undefined)?.[segment];
    }
    return smallestInstance(target, root);
  }
  if ('const' in node) {
    return node.const;
  }
  if (Array.isArray(node.enum)) {
    return node.enum.includes(null) ? null : node.enum[0];
  }
  const variants = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    const instances = variants.map((variant) => smallestInstance(variant, root));
    // Every nullable value is null (ADR-0010), even when another variant is as short as `null`.
    if (instances.includes(null)) {
      return null;
    }
    return instances.reduce((best, candidate) =>
      JSON.stringify(candidate).length < JSON.stringify(best).length ? candidate : best,
    );
  }
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    return smallestInstance(node.allOf[0], root);
  }
  const types = Array.isArray(node.type) ? (node.type as string[]) : [node.type as string];
  if (types.includes('null')) {
    return null;
  }
  switch (types[0]) {
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        result[key] = smallestInstance(value, root);
      }
      return result;
    }
    case 'array':
      return [];
    case 'string':
      if (node.format === 'date') {
        return '1970-01-01';
      }
      if (node.format === 'date-time') {
        return '1970-01-01T00:00:00.000Z';
      }
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new AiProviderError('timeout', 'The request was aborted'));
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}

/**
 * Deterministic LLM without network (ADR-0010 section 2), used in tests and, outside
 * production, whenever no Anthropic key is set.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly info: AiProviderInfo = { name: 'fake', model: FAKE_LLM_MODEL, fake: true };

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    if (signal.aborted) {
      throw new AiProviderError('timeout', 'The request was aborted');
    }
    const input = userText(request.messages);
    const respond = (text: string, stopReason: LlmResponse['stopReason'] = 'end'): LlmResponse => ({
      text,
      stopReason,
      usage: {
        inputTokens: fakeTokens(request.system + input),
        outputTokens: fakeTokens(text),
      },
      model: FAKE_LLM_MODEL,
      requestId: null,
    });

    if (input.includes(FAKE_LLM_MARKERS.fail)) {
      throw new AiProviderError('http_529', 'The fake provider is overloaded');
    }
    if (input.includes(FAKE_LLM_MARKERS.slow)) {
      return waitForAbort(signal);
    }
    if (input.includes(FAKE_LLM_MARKERS.refuse)) {
      return respond('', 'refusal');
    }
    if (input.includes(FAKE_LLM_MARKERS.invalid)) {
      return respond('not json');
    }
    const injected = injectedAnswer(input);
    if (injected !== null) {
      return respond(injected);
    }
    if (request.responseFormat.type === 'json_schema') {
      return respond(JSON.stringify(smallestInstance(request.responseFormat.schema)));
    }
    return Promise.resolve(respond(FAKE_NARRATIVE));
  }

  estimateCostUsd(usage: { inputTokens: number; outputTokens: number }, model: string) {
    return estimateTokenCostUsd(model, usage);
  }
}
