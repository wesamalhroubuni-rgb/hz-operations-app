import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { buildCaptureOutputSchema, toStructuredOutputJsonSchema } from '@ops/shared';
import {
  estimateTokenCostUsd,
  estimateTranscriptionCostUsd,
  MODEL_PRICES,
  priceOf,
} from './ai-prices';
import { aiSettingsFromConfig, type AiSettings } from './ai-settings';
import { AnthropicLlmProvider } from './anthropic-llm-provider';
import { FAKE_NARRATIVE, FakeLlmProvider, fakeTokens, smallestInstance } from './fake-llm-provider';
import { FAKE_TRANSCRIPT, FakeSpeechToTextProvider } from './fake-speech-to-text-provider';
import { AiProviderError, type LlmRequest } from './llm-provider';
import { OpenAiSpeechToTextProvider } from './openai-speech-to-text-provider';
import { untrustedDataBlock } from './prompt-data';
import { resolveAiProviders } from './provider-registry';

const signal = () => new AbortController().signal;

function settings(overrides: Partial<AiSettings>): AiSettings {
  return {
    mode: 'auto',
    nodeEnv: 'development',
    anthropicApiKey: null,
    openAiApiKey: null,
    llmModel: 'claude-opus-5-5',
    sttModel: 'gpt-4o-transcribe',
    requestTimeoutMs: 30_000,
    dailyRequestLimit: 500,
    dailyCostLimitUsd: 10,
    rateLimitPerUserPerMinute: 6,
    anthropicRefusalFallback: false,
    ...overrides,
  };
}

describe('provider registry', () => {
  const KEYS = { anthropicApiKey: 'anthropic-test-key', openAiApiKey: 'openai-test-key' };
  const names = (resolved: ReturnType<typeof resolveAiProviders>) => ({
    llm: resolved.llm?.info.name ?? null,
    speechToText: resolved.speechToText?.info.name ?? null,
  });

  it.each([
    // mode, keys, NODE_ENV, expected llm, expected speech-to-text
    ['auto', 'none', 'development', 'fake', 'fake'],
    ['auto', 'none', 'test', 'fake', 'fake'],
    ['auto', 'none', 'production', null, null],
    ['auto', 'anthropic', 'development', 'anthropic', 'fake'],
    ['auto', 'anthropic', 'production', 'anthropic', null],
    ['auto', 'openai', 'development', 'fake', 'openai'],
    ['auto', 'openai', 'production', null, 'openai'],
    ['auto', 'both', 'development', 'anthropic', 'openai'],
    ['auto', 'both', 'production', 'anthropic', 'openai'],
    ['fake', 'none', 'development', 'fake', 'fake'],
    ['fake', 'both', 'development', 'fake', 'fake'],
    ['fake', 'both', 'test', 'fake', 'fake'],
    ['real', 'both', 'development', 'anthropic', 'openai'],
    ['real', 'both', 'production', 'anthropic', 'openai'],
  ] as const)('%s with %s key(s) in %s: llm %s, speech %s', (mode, keys, nodeEnv, llm, stt) => {
    const resolved = resolveAiProviders(
      settings({
        mode,
        nodeEnv,
        anthropicApiKey: keys === 'anthropic' || keys === 'both' ? KEYS.anthropicApiKey : null,
        openAiApiKey: keys === 'openai' || keys === 'both' ? KEYS.openAiApiKey : null,
      }),
    );
    expect(names(resolved)).toEqual({ llm, speechToText: stt });
  });

  it('refuses the fakes in production', () => {
    expect(() =>
      resolveAiProviders(settings({ mode: 'fake', nodeEnv: 'production', ...KEYS })),
    ).toThrow(/refused in production/);
  });

  it.each([
    ['none', /ANTHROPIC_API_KEY and OPENAI_API_KEY/],
    ['anthropic', /OPENAI_API_KEY/],
    ['openai', /ANTHROPIC_API_KEY/],
  ] as const)('refuses real mode with %s key(s)', (keys, message) => {
    expect(() =>
      resolveAiProviders(
        settings({
          mode: 'real',
          anthropicApiKey: keys === 'anthropic' ? KEYS.anthropicApiKey : null,
          openAiApiKey: keys === 'openai' ? KEYS.openAiApiKey : null,
        }),
      ),
    ).toThrow(message);
  });

  it('passes AI_ANTHROPIC_REFUSAL_FALLBACK to the Anthropic adapter (off by default)', () => {
    const request: LlmRequest = {
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      maxOutputTokens: 10,
      responseFormat: { type: 'text' },
    };
    const off = resolveAiProviders(settings({ ...KEYS })).llm as AnthropicLlmProvider;
    expect(off.buildParams(request)).not.toHaveProperty('fallbacks');
    expect(off.buildParams(request)).not.toHaveProperty('betas');
    const on = resolveAiProviders(settings({ ...KEYS, anthropicRefusalFallback: true }))
      .llm as AnthropicLlmProvider;
    expect(on.buildParams(request)).toMatchObject({
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
  });

  it('reads AI_ANTHROPIC_REFUSAL_FALLBACK from the configuration, false unless true', () => {
    const configOf = (values: Record<string, unknown>) =>
      ({ get: (key: string) => values[key] }) as never;
    expect(aiSettingsFromConfig(configOf({})).anthropicRefusalFallback).toBe(false);
    expect(
      aiSettingsFromConfig(configOf({ AI_ANTHROPIC_REFUSAL_FALLBACK: false }))
        .anthropicRefusalFallback,
    ).toBe(false);
    expect(
      aiSettingsFromConfig(configOf({ AI_ANTHROPIC_REFUSAL_FALLBACK: true }))
        .anthropicRefusalFallback,
    ).toBe(true);
  });

  it('builds the real providers with the configured models', () => {
    const resolved = resolveAiProviders(
      settings({ ...KEYS, llmModel: 'claude-haiku-5-5', sttModel: 'whisper-1' }),
    );
    expect(resolved.llm?.info).toEqual({
      name: 'anthropic',
      model: 'claude-haiku-5-5',
      fake: false,
    });
    expect(resolved.speechToText?.info).toEqual({
      name: 'openai',
      model: 'whisper-1',
      fake: false,
    });
  });
});

describe('price table', () => {
  it('knows the current Claude models and the default speech-to-text model', () => {
    expect(MODEL_PRICES['claude-opus-5-5']).toEqual({
      inputPerMillionTokens: 4,
      outputPerMillionTokens: 20,
    });
    expect(MODEL_PRICES['claude-sonnet-5-5']).toEqual({
      inputPerMillionTokens: 2,
      outputPerMillionTokens: 10,
    });
    expect(MODEL_PRICES['claude-haiku-5-5']).toEqual({
      inputPerMillionTokens: 0.1,
      outputPerMillionTokens: 0.5,
    });
    expect(MODEL_PRICES['gpt-4o-transcribe']?.perAudioMinute).toBe(0.006);
  });

  it('estimates token costs', () => {
    expect(
      estimateTokenCostUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBe(4);
    expect(estimateTokenCostUsd('claude-opus-5-5', { inputTokens: 2000, outputTokens: 500 })).toBe(
      0.018,
    );
    expect(
      estimateTokenCostUsd('claude-haiku-5-5', { inputTokens: 1000, outputTokens: 1000 }),
    ).toBe(0.0006);
  });

  it('prices every fake model at $10 per million tokens both ways', () => {
    expect(priceOf('fake-anything')).toEqual({
      inputPerMillionTokens: 10,
      outputPerMillionTokens: 10,
    });
    expect(estimateTokenCostUsd('fake-llm-1', { inputTokens: 50_000, outputTokens: 50_000 })).toBe(
      1,
    );
  });

  it('estimates an unknown model as null', () => {
    expect(priceOf('claude-unknown-9')).toBeNull();
    expect(estimateTokenCostUsd('claude-unknown-9', { inputTokens: 1, outputTokens: 1 })).toBe(
      null,
    );
    expect(
      estimateTranscriptionCostUsd('stt-unknown', {
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 60,
      }),
    ).toBeNull();
  });

  it('estimates transcription by tokens when reported, else by minutes', () => {
    expect(
      estimateTranscriptionCostUsd('gpt-4o-transcribe', {
        inputTokens: 1000,
        outputTokens: 100,
        audioSeconds: 120,
      }),
    ).toBe(0.007);
    expect(
      estimateTranscriptionCostUsd('gpt-4o-transcribe', {
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 120,
      }),
    ).toBe(0.012);
    expect(
      estimateTranscriptionCostUsd('whisper-1', {
        inputTokens: 5,
        outputTokens: 5,
        audioSeconds: 30,
      }),
    ).toBe(0.003);
  });
});

function llmRequest(text: string, json = false): LlmRequest {
  return {
    system: 'System prompt.',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    maxOutputTokens: 1000,
    responseFormat: json
      ? {
          type: 'json_schema',
          name: 'answer',
          schema: toStructuredOutputJsonSchema(z.object({ value: z.string().nullable() })),
        }
      : { type: 'text' },
  };
}

describe('FakeLlmProvider', () => {
  const fake = new FakeLlmProvider();

  it('answers the fixed narrative for text, with tokens of ceil(chars / 4)', async () => {
    const response = await fake.generate(llmRequest('Summarise the day.'), signal());
    expect(response).toEqual({
      text: FAKE_NARRATIVE,
      stopReason: 'end',
      usage: {
        inputTokens: fakeTokens('System prompt.' + 'Summarise the day.'),
        outputTokens: fakeTokens(FAKE_NARRATIVE),
      },
      model: 'fake-llm-1',
      requestId: null,
    });
    expect(/\d/.test(FAKE_NARRATIVE)).toBe(false);
  });

  it('answers the smallest valid instance of a json schema', async () => {
    const response = await fake.generate(llmRequest('Extract.', true), signal());
    expect(JSON.parse(response.text)).toEqual({ value: null });
  });

  it('chooses the "no log type" variant of a capture schema', () => {
    const schema = buildCaptureOutputSchema({
      logTypes: [
        {
          key: 'repair',
          fields: [{ key: 'parts', label: 'Parts', type: 'number', required: true }],
        },
      ],
      taskRefs: ['T1'],
      siteRefs: ['S1'],
    });
    const instance = smallestInstance(toStructuredOutputJsonSchema(schema));
    expect(schema.safeParse(instance).success).toBe(true);
    expect((instance as { logType: { key: unknown } }).logType.key).toBeNull();
    // Every nullable value is null (ADR-0010), also a reference enum as short as `null`.
    expect(instance).toMatchObject({ taskRef: null, siteRef: null });
  });

  it('prefers null over any other variant of a union that allows it', () => {
    expect(smallestInstance({ anyOf: [{ type: 'string', enum: ['T1'] }, { type: 'null' }] })).toBe(
      null,
    );
    expect(smallestInstance({ anyOf: [{ type: 'integer' }, { type: 'null' }] })).toBe(null);
    expect(smallestInstance({ anyOf: [{ type: 'string', enum: ['T1', 'T2'] }] })).toBe('T1');
  });

  it('answers exactly the JSON after FAKE-LLM-JSON:, to the end of its data block', async () => {
    const block = untrustedDataBlock('transcript', 'FAKE-LLM-JSON: {"value": "<b> & c"}');
    const response = await fake.generate(
      llmRequest(`Read this:\n${block}\nThanks.`, true),
      signal(),
    );
    expect(response.text).toBe('{"value": "<b> & c"}');
  });

  it('answers "not json" for FAKE-LLM-INVALID and a refusal for FAKE-LLM-REFUSE', async () => {
    expect((await fake.generate(llmRequest('FAKE-LLM-INVALID', true), signal())).text).toBe(
      'not json',
    );
    expect((await fake.generate(llmRequest('FAKE-LLM-REFUSE'), signal())).stopReason).toBe(
      'refusal',
    );
  });

  it('fails with http_529 for FAKE-LLM-FAIL', async () => {
    await expect(fake.generate(llmRequest('FAKE-LLM-FAIL'), signal())).rejects.toMatchObject({
      name: 'AiProviderError',
      code: 'http_529',
    });
  });

  it('waits for the abort signal for FAKE-LLM-SLOW', async () => {
    const controller = new AbortController();
    const pending = fake.generate(llmRequest('FAKE-LLM-SLOW'), controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('only reads markers in the user content, not the system prompt', async () => {
    const request = { ...llmRequest('Hello'), system: 'FAKE-LLM-FAIL' };
    expect((await fake.generate(request, signal())).text).toBe(FAKE_NARRATIVE);
  });
});

describe('FakeSpeechToTextProvider', () => {
  const fake = new FakeSpeechToTextProvider();
  const request = (bytes: Uint8Array, extra: object = {}) => ({
    audio: bytes,
    mimeType: 'audio/mp4',
    fileName: 'capture.m4a',
    languageHint: null,
    ...extra,
  });

  it('transcribes the UTF-8 text after FAKE-STT: up to a NUL byte', async () => {
    const audio = Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from('FAKE-STT:İki boru değiştirildi', 'utf8'),
      Buffer.from([0, 9, 9]),
    ]);
    const result = await fake.transcribe(
      request(new Uint8Array(audio), { languageHint: 'tr', durationSeconds: 12 }),
      signal(),
    );
    expect(result).toMatchObject({
      text: 'İki boru değiştirildi',
      language: 'tr',
      durationSeconds: 12,
      model: 'fake-stt-1',
    });
  });

  it('answers "Fake transcript" in English for 1 second without a marker or hints', async () => {
    const result = await fake.transcribe(request(new Uint8Array([1, 2, 3])), signal());
    expect(result).toMatchObject({ text: FAKE_TRANSCRIPT, language: 'en', durationSeconds: 1 });
  });
});

describe('AnthropicLlmProvider', () => {
  const API_KEY = 'sk-ant-test-0000000000000000';

  function stub(response: object | Error) {
    const create = jest.fn(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    );
    return { create, client: { beta: { messages: { create } } } };
  }

  const MESSAGE = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'text', text: '{"value":' },
      { type: 'text', text: '"ok"}' },
    ],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: null,
    },
    _request_id: 'req_123',
  };

  it('sends one structured-output request with effort low, the fallback when on, and no retries', async () => {
    const { create, client } = stub(MESSAGE);
    const provider = new AnthropicLlmProvider(API_KEY, 'claude-opus-5-5', client as never, {
      refusalFallback: true,
    });
    const controller = new AbortController();
    const request = llmRequest('Read this', true);
    request.messages[0]!.content.push({
      type: 'image',
      mediaType: 'image/jpeg',
      data: new Uint8Array([255, 216, 255]),
    });

    const response = await provider.generate(request, controller.signal);

    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      system: 'System prompt.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } },
          ],
        },
      ],
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema:
            request.responseFormat.type === 'json_schema' ? request.responseFormat.schema : null,
        },
      },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    expect(options).toEqual({ signal: controller.signal, maxRetries: 0 });
    expect(JSON.stringify(params)).not.toContain(API_KEY);
    expect(response).toEqual({
      text: '{"value":"ok"}',
      stopReason: 'end',
      usage: { inputTokens: 105, outputTokens: 20 },
      model: 'claude-opus-5',
      requestId: 'req_123',
    });
  });

  it('sends no refusal fallback unless switched on', () => {
    const provider = new AnthropicLlmProvider(
      API_KEY,
      'claude-opus-5-5',
      stub(MESSAGE).client as never,
    );
    const params = provider.buildParams(llmRequest('Write', true));
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
    expect(params).toHaveProperty('output_config');
  });

  it('sends no output format for text and no effort for a model without it', () => {
    const provider = new AnthropicLlmProvider(
      API_KEY,
      'claude-haiku-4-5',
      stub(MESSAGE).client as never,
    );
    const params = provider.buildParams(llmRequest('Write'));
    expect(params).not.toHaveProperty('output_config');
  });

  it.each([
    ['refusal', 'refusal'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'max_tokens'],
    ['stop_sequence', 'end'],
    ['pause_turn', 'other'],
  ])('maps stop_reason %s to %s', async (stopReason, expected) => {
    const provider = new AnthropicLlmProvider(
      API_KEY,
      'claude-opus-5-5',
      stub({ ...MESSAGE, stop_reason: stopReason }).client as never,
    );
    expect((await provider.generate(llmRequest('x'), signal())).stopReason).toBe(expected);
  });

  it.each([
    [
      () => new Anthropic.APIError(529, undefined, `overloaded ${API_KEY}`, new Headers()),
      'http_529',
    ],
    [() => new Anthropic.APIError(413, undefined, 'too large', new Headers()), 'input_rejected'],
    [() => new Anthropic.APIConnectionError({ message: `down ${API_KEY}` }), 'network'],
    [() => new Anthropic.APIUserAbortError(), 'timeout'],
    [() => new Error(`boom ${API_KEY}`), 'provider_error'],
  ] as Array<[() => Error, string]>)(
    'maps a failure to a clean AiProviderError (%#)',
    async (make, code) => {
      const provider = new AnthropicLlmProvider(
        API_KEY,
        'claude-opus-5-5',
        stub(make()).client as never,
      );
      const error = (await provider
        .generate(llmRequest('x'), signal())
        .catch((e: unknown) => e)) as AiProviderError;
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(API_KEY);
    },
  );

  it('reports a timeout when the signal aborted, whatever the SDK threw', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new AnthropicLlmProvider(
      API_KEY,
      'claude-opus-5-5',
      stub(new Error('x')).client as never,
    );
    await expect(provider.generate(llmRequest('x'), controller.signal)).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('OpenAiSpeechToTextProvider', () => {
  const API_KEY = 'sk-openai-test-000000000000';
  const audioRequest = {
    audio: new Uint8Array([1, 2, 3, 4]),
    mimeType: 'audio/mp4',
    fileName: 'capture.m4a',
    languageHint: 'ar',
  };

  it('posts one multipart request with the audio, model and language hint', async () => {
    const fetchMock = jest.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            text: 'تم إصلاح الأنبوب',
            usage: { type: 'tokens', input_tokens: 50, output_tokens: 10 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const provider = new OpenAiSpeechToTextProvider(API_KEY, 'gpt-4o-transcribe', fetchMock);
    const controller = new AbortController();
    const result = await provider.transcribe(audioRequest, controller.signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toEqual({ Authorization: `Bearer ${API_KEY}` });
    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-transcribe');
    expect(form.get('language')).toBe('ar');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('capture.m4a');
    expect(file.type).toBe('audio/mp4');
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect([...form.keys()].sort()).toEqual(['file', 'language', 'model', 'response_format']);
    expect(result).toEqual({
      text: 'تم إصلاح الأنبوب',
      language: null,
      durationSeconds: null,
      usage: { inputTokens: 50, outputTokens: 10 },
      model: 'gpt-4o-transcribe',
    });
  });

  it('sends no language without a hint and reads a duration usage', async () => {
    const fetchMock = jest.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ text: 'hi', usage: { type: 'duration', seconds: 7 } })),
      ),
    );
    const provider = new OpenAiSpeechToTextProvider(API_KEY, 'whisper-1', fetchMock);
    const result = await provider.transcribe({ ...audioRequest, languageHint: null }, signal());
    expect((fetchMock.mock.calls[0]![1].body as FormData).has('language')).toBe(false);
    expect(result.durationSeconds).toBe(7);
  });

  it.each([
    [400, 'input_rejected'],
    [413, 'input_rejected'],
    [401, 'http_401'],
    [429, 'http_429'],
    [500, 'http_500'],
  ])('maps HTTP %i to %s without reading the body into the message', async (status, code) => {
    const fetchMock = jest.fn(() =>
      Promise.resolve(new Response(`{"error":"bad key ${API_KEY}"}`, { status })),
    );
    const provider = new OpenAiSpeechToTextProvider(API_KEY, 'gpt-4o-transcribe', fetchMock);
    const error = (await provider
      .transcribe(audioRequest, signal())
      .catch((e: unknown) => e)) as AiProviderError;
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(API_KEY);
  });

  it('maps a network failure and an abort', async () => {
    const failing = new OpenAiSpeechToTextProvider(API_KEY, 'm', () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    await expect(failing.transcribe(audioRequest, signal())).rejects.toMatchObject({
      code: 'network',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(failing.transcribe(audioRequest, controller.signal)).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('refuses an answer without text', async () => {
    const provider = new OpenAiSpeechToTextProvider(API_KEY, 'm', () =>
      Promise.resolve(new Response('{}')),
    );
    await expect(provider.transcribe(audioRequest, signal())).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});
