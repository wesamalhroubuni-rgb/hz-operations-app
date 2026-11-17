import { Logger } from '@nestjs/common';
import { AiKeyChecker } from './ai-key-checker';
import type { AiSettings } from './ai-settings';
import { AiProviderError } from './llm-provider';
import { checkOpenAiKey, OPENAI_MODELS_URL } from './openai-speech-to-text-provider';
import { REAL_PROVIDERS, type RealProviderFactories } from './provider-registry';

const KEY = 'sk-proj-checker-never-logged-0000';

const settings = {
  llmModel: 'claude-opus-5-5',
  sttModel: 'gpt-4o-transcribe',
  requestTimeoutMs: 50,
} as AiSettings;

describe('AiKeyChecker (ADR-0012)', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
    }
  });
  afterEach(() => jest.restoreAllMocks());

  const checker = (check: RealProviderFactories['checkLlmKey']) =>
    new AiKeyChecker(settings, {
      ...REAL_PROVIDERS,
      checkLlmKey: check,
      checkSpeechToTextKey: check,
    });

  it('passes the configured model and reports ok', async () => {
    const models: string[] = [];
    const run = checker((_key, model) => {
      models.push(model);
      return Promise.resolve();
    });
    expect(await run.check('org', 'llm', KEY)).toEqual({ ok: true });
    expect(await run.check('org', 'speechToText', KEY)).toEqual({ ok: true });
    expect(models).toEqual(['claude-opus-5-5', 'gpt-4o-transcribe']);
  });

  it.each([
    ['http_401', 'rejected'],
    ['http_403', 'rejected'],
    ['http_404', 'rejected'],
    ['http_429', 'unavailable'],
    ['http_529', 'unavailable'],
    ['network', 'unavailable'],
  ])('maps %s to %s and never logs the key', async (code, failure) => {
    const run = checker(() => Promise.reject(new AiProviderError(code, 'refused')));
    expect(await run.check('org', 'llm', KEY)).toEqual({ ok: false, failure, errorCode: code });
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('times out after AI_REQUEST_TIMEOUT_MS', async () => {
    const run = checker(
      (_key, _model, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    expect(await run.check('org', 'llm', KEY)).toEqual({
      ok: false,
      failure: 'unavailable',
      errorCode: 'timeout',
    });
  });
});

describe('checkOpenAiKey', () => {
  const signal = () => new AbortController().signal;

  it('reads the model with the key as a bearer token', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    await checkOpenAiKey(KEY, 'gpt-4o-transcribe', signal(), (url, init) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    expect(calls).toEqual([
      { url: `${OPENAI_MODELS_URL}/gpt-4o-transcribe`, auth: `Bearer ${KEY}` },
    ]);
  });

  it('rejects with the HTTP status, without the body or the key in the message', async () => {
    const failure = checkOpenAiKey(KEY, 'm', signal(), () =>
      Promise.resolve(new Response(`bad key ${KEY}`, { status: 401 })),
    );
    await expect(failure).rejects.toMatchObject({ code: 'http_401' });
    await expect(failure).rejects.not.toHaveProperty('message', expect.stringContaining(KEY));
  });

  it('reports a network failure', async () => {
    await expect(
      checkOpenAiKey(KEY, 'm', signal(), () => Promise.reject(new Error('offline'))),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
