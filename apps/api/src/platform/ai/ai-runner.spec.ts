import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiRunnerService } from './ai-runner.service';
import type { AiSettings } from './ai-settings';
import type { AiTraceInput, AiTraceService } from './ai-trace.service';
import { utcDayKey } from './ai-trace.service';
import type { AiCall, AiOrganizationLimits, AiUsageRow } from './ai-types';
import { FakeLlmProvider } from './fake-llm-provider';
import { FakeSpeechToTextProvider } from './fake-speech-to-text-provider';
import {
  AiProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from './llm-provider';
import { untrustedDataBlock } from './prompt-data';
import { FilePromptLoader } from './prompt-loader';
import type { SpeechToTextProvider } from './speech-to-text-provider';
import { AiUsageLimiter } from './usage-limiter';

const ORG = '0190f3a2-7c1e-7000-8000-0000000000aa';
const USER = '0190f3a2-7c1e-7000-8000-000000000001';
const SECRET_KEY = 'sk-ant-never-in-a-log-0000000000';
const TRANSCRIPT = 'Pump at site Kadıköy repaired by Ayşe, phone 0532 000 00 00';

/** An in-memory `AiTrace` table with the same `today` rule as the real service. */
class MemoryTraces {
  readonly rows: Array<AiTraceInput & { id: string; decision?: string; decidedById?: string }> = [];

  record(trace: AiTraceInput): Promise<string> {
    const id = `trace-${this.rows.length + 1}`;
    this.rows.push({ ...trace, id });
    return Promise.resolve(id);
  }

  decide(ids: readonly string[], decision: string, decidedById: string): Promise<void> {
    for (const row of this.rows) {
      if (ids.includes(row.id) && row.decision === undefined) {
        row.decision = decision;
        row.decidedById = decidedById;
      }
    }
    return Promise.resolve();
  }

  today(organizationId: string, now: Date) {
    const rows = this.rows.filter(
      (row) =>
        row.organizationId === organizationId &&
        row.status !== 'limited' &&
        utcDayKey(row.createdAt) === utcDayKey(now),
    );
    return Promise.resolve({
      requests: rows.length,
      costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    });
  }

  usage(): Promise<AiUsageRow[]> {
    return Promise.resolve([]);
  }
}

/** An LLM that answers from a script, one entry per call. */
class ScriptedLlm implements LlmProvider {
  readonly info = { name: 'scripted', model: 'fake-scripted', fake: true };
  readonly requests: LlmRequest[] = [];

  constructor(private readonly script: Array<Partial<LlmResponse> | Error>) {}

  generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (next === undefined) {
      throw new Error('script exhausted');
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve({
      text: '',
      stopReason: 'end',
      usage: { inputTokens: 100, outputTokens: 10 },
      model: 'fake-scripted',
      requestId: null,
      ...next,
    });
  }

  estimateCostUsd(usage: { inputTokens: number; outputTokens: number }) {
    return (usage.inputTokens + usage.outputTokens) / 1_000_000;
  }
}

describe('AiRunnerService', () => {
  let promptDir: string;
  let traces: MemoryTraces;
  let now: Date;
  let orgLimits: AiOrganizationLimits;
  let logLines: string[];

  const settings = (overrides: Partial<AiSettings> = {}): AiSettings => ({
    mode: 'fake',
    nodeEnv: 'test',
    anthropicApiKey: SECRET_KEY,
    openAiApiKey: null,
    llmModel: 'claude-opus-5-5',
    sttModel: 'gpt-4o-transcribe',
    requestTimeoutMs: 2000,
    dailyRequestLimit: 100,
    dailyCostLimitUsd: 10,
    rateLimitPerUserPerMinute: 50,
    anthropicRefusalFallback: false,
    ...overrides,
  });

  function runner(
    llm: LlmProvider | null,
    options: { settings?: Partial<AiSettings>; speech?: SpeechToTextProvider | null } = {},
  ) {
    const resolved = settings(options.settings);
    const limiter = new AiUsageLimiter(
      resolved,
      { limitsFor: () => Promise.resolve(orgLimits) },
      traces,
    );
    return new AiRunnerService(
      resolved,
      llm,
      options.speech === undefined ? new FakeSpeechToTextProvider() : options.speech,
      new FilePromptLoader([promptDir]),
      { now: () => now },
      traces as unknown as AiTraceService,
      limiter,
    );
  }

  const call = (overrides: Partial<AiCall> = {}): AiCall => ({
    organizationId: ORG,
    feature: 'test_feature',
    requestedById: USER,
    rateLimitKey: USER,
    prompt: { id: 'runner-test', version: 1 },
    inputRefs: { subjectType: 'test', subjectId: 'abc' },
    ...overrides,
  });

  const schema = z.object({ count: z.number().int().min(0), note: z.string().nullable() });
  const structured = (
    text = 'Count the pipes.',
    validate?: (value: z.infer<typeof schema>) => string | null,
  ) => ({
    system: 'You extract counts.',
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: untrustedDataBlock('transcript', text) }],
      },
    ],
    schema,
    schemaName: 'pipe_count',
    maxOutputTokens: 500,
    validate,
  });

  beforeAll(() => {
    promptDir = mkdtempSync(join(tmpdir(), 'ops-runner-'));
    writeFileSync(
      join(promptDir, 'runner-test.v1.md'),
      '---\nid: runner-test\nversion: 1\npurpose: Runner tests.\n---\nYou extract counts.\n',
    );
  });
  afterAll(() => rmSync(promptDir, { recursive: true, force: true }));

  beforeEach(() => {
    traces = new MemoryTraces();
    now = new Date('2026-11-01T10:00:00.000Z');
    orgLimits = { dailyRequestLimit: null, dailyCostLimitUsd: null };
    logLines = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void logLines.push(String(args[0])));
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns a valid structured answer with one ok trace', async () => {
    const llm = new ScriptedLlm([{ text: '{"count": 2, "note": null}', model: 'fake-answered' }]);
    const outcome = await runner(llm).generateStructured(call(), structured());
    expect(outcome).toEqual({
      ok: true,
      value: { count: 2, note: null },
      traceIds: ['trace-1'],
      provider: { name: 'scripted', model: 'fake-answered', fake: true },
      usage: { inputTokens: 100, outputTokens: 10, audioSeconds: 0, costUsd: 0.00011 },
    });
    expect(traces.rows).toHaveLength(1);
    expect(traces.rows[0]).toMatchObject({
      organizationId: ORG,
      feature: 'test_feature',
      provider: 'scripted',
      model: 'fake-answered',
      prompt: { id: 'runner-test', version: 1 },
      attempt: 1,
      status: 'ok',
      output: { count: 2, note: null },
      errorCode: null,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.00011,
      requestedById: USER,
      createdAt: now,
    });
    expect(traces.rows[0]!.inputRefs).toEqual({
      subjectType: 'test',
      subjectId: 'abc',
      promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The provider got the JSON Schema form of the Zod schema.
    expect(llm.requests[0]!.responseFormat).toMatchObject({
      type: 'json_schema',
      name: 'pipe_count',
      schema: { type: 'object', additionalProperties: false },
    });
  });

  it('retries once with the reason added, then succeeds (2 traces)', async () => {
    const llm = new ScriptedLlm([
      { text: '{"count": -1, "note": null}' },
      { text: '{"count": 3, "note": "ok"}' },
    ]);
    const outcome = await runner(llm).generateStructured(call(), structured());
    expect(outcome.ok).toBe(true);
    expect(outcome.traceIds).toEqual(['trace-1', 'trace-2']);
    expect(traces.rows.map((row) => [row.attempt, row.status, row.errorCode])).toEqual([
      [1, 'invalid_output', 'schema_mismatch'],
      [2, 'ok', null],
    ]);
    expect(traces.rows[0]!.output).toBeNull();
    const retry = llm.requests[1]!.messages;
    expect(retry).toHaveLength(2);
    expect(retry[1]!.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('count'),
    });
    if (outcome.ok) {
      expect(outcome.usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
    }
  });

  it('gives invalid_output after two invalid answers, with two traces', async () => {
    const outcome = await runner(new FakeLlmProvider()).generateStructured(
      call(),
      structured('FAKE-LLM-INVALID'),
    );
    expect(outcome).toEqual({
      ok: false,
      failure: 'invalid_output',
      traceIds: ['trace-1', 'trace-2'],
      provider: { name: 'fake', model: 'fake-llm-1', fake: true },
      errorCode: 'unparsable_json',
    });
    expect(traces.rows.map((row) => row.status)).toEqual(['invalid_output', 'invalid_output']);
  });

  it('treats a validate refusal and a max_tokens cut as invalid output', async () => {
    const llm = new ScriptedLlm([
      { text: '{"count": 1, "note": null}' },
      { text: '{"count": 1', stopReason: 'max_tokens' },
    ]);
    const outcome = await runner(llm).generateStructured(
      call(),
      structured('x', (value) => (value.count < 2 ? 'count must be at least 2' : null)),
    );
    expect(outcome).toMatchObject({
      ok: false,
      failure: 'invalid_output',
      errorCode: 'max_tokens',
    });
    expect(traces.rows.map((row) => row.errorCode)).toEqual(['validation_failed', 'max_tokens']);
    expect(llm.requests[1]!.messages.at(-1)!.content[0]).toMatchObject({
      text: expect.stringContaining('count must be at least 2'),
    });
  });

  it('answers the injected JSON of the fake end to end', async () => {
    const outcome = await runner(new FakeLlmProvider()).generateStructured(
      call(),
      structured('FAKE-LLM-JSON: {"count": 7, "note": "<ok>"}'),
    );
    expect(outcome).toMatchObject({ ok: true, value: { count: 7, note: '<ok>' } });
  });

  it('does not retry a refusal', async () => {
    const outcome = await runner(new FakeLlmProvider()).generateStructured(
      call(),
      structured('FAKE-LLM-REFUSE'),
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'refused', errorCode: 'refused' });
    expect(traces.rows.map((row) => [row.status, row.errorCode])).toEqual([['failed', 'refused']]);
  });

  it('does not retry a provider error', async () => {
    const outcome = await runner(new FakeLlmProvider()).generateStructured(
      call(),
      structured('FAKE-LLM-FAIL'),
    );
    expect(outcome).toEqual({
      ok: false,
      failure: 'unavailable',
      traceIds: ['trace-1'],
      provider: { name: 'fake', model: 'fake-llm-1', fake: true },
      errorCode: 'http_529',
    });
    expect(traces.rows[0]).toMatchObject({ status: 'failed', errorCode: 'http_529' });
  });

  it('maps input_rejected and unexpected errors', async () => {
    const llm = new ScriptedLlm([
      new AiProviderError('input_rejected', 'too large'),
      new Error(`unexpected ${SECRET_KEY}`),
    ]);
    const run = runner(llm);
    expect(
      await run.generateText(call(), { system: 's', messages: [], maxOutputTokens: 10 }),
    ).toMatchObject({
      failure: 'input_rejected',
      errorCode: 'input_rejected',
    });
    expect(
      await run.generateText(call(), { system: 's', messages: [], maxOutputTokens: 10 }),
    ).toMatchObject({
      failure: 'unavailable',
      errorCode: 'provider_error',
    });
  });

  it.each([400, 401, 403, 404, 422])(
    'maps HTTP %i to rejected (configuration or request refused, not an outage) and logs an error',
    async (status) => {
      const llm = new ScriptedLlm([new AiProviderError(`http_${status}`, 'refused')]);
      const outcome = await runner(llm).generateText(call(), {
        system: 's',
        messages: [],
        maxOutputTokens: 10,
      });
      expect(outcome).toMatchObject({
        ok: false,
        failure: 'rejected',
        errorCode: `http_${status}`,
        traceIds: ['trace-1'],
      });
      expect(traces.rows).toHaveLength(1);
      expect(traces.rows[0]).toMatchObject({ status: 'failed', errorCode: `http_${status}` });
      const errors = (Logger.prototype.error as jest.Mock).mock.calls.map((args) =>
        String(args[0]),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`errorCode=http_${status}`);
      expect(errors[0]).toContain('traceId=trace-1');
      expect(errors[0]).toContain(`organizationId=${ORG}`);
    },
  );

  it.each(['http_408', 'http_409', 'http_429', 'http_500', 'http_529', 'network'])(
    'keeps %s a retryable unavailable',
    async (code) => {
      const llm = new ScriptedLlm([new AiProviderError(code, 'down')]);
      const outcome = await runner(llm).generateText(call(), {
        system: 's',
        messages: [],
        maxOutputTokens: 10,
      });
      expect(outcome).toMatchObject({ ok: false, failure: 'unavailable', errorCode: code });
      expect(Logger.prototype.error as jest.Mock).not.toHaveBeenCalled();
    },
  );

  it('maps a rejected transcription to rejected too', async () => {
    const speech: SpeechToTextProvider = {
      info: { name: 'scripted-stt', model: 'stt-x', fake: true },
      transcribe: () => Promise.reject(new AiProviderError('http_401', 'bad key')),
      estimateCostUsd: () => null,
    };
    const outcome = await runner(new FakeLlmProvider(), { speech }).transcribe(
      call({ prompt: null }),
      {
        audio: new Uint8Array([1]),
        mimeType: 'audio/mp4',
        fileName: 'capture.m4a',
        languageHint: null,
      },
    );
    expect(outcome).toMatchObject({ ok: false, failure: 'rejected', errorCode: 'http_401' });
  });

  it('estimates the cost with the configured model when the answering model has no price', async () => {
    const llm: LlmProvider = {
      info: { name: 'priced', model: 'priced-model', fake: false },
      generate: () =>
        Promise.resolve({
          text: 'Done.',
          stopReason: 'end',
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
          model: 'unpriced-fallback-model',
          requestId: null,
        }),
      estimateCostUsd: (_usage, model) => (model === 'priced-model' ? 4 : null),
    };
    const outcome = await runner(llm).generateText(call(), {
      system: 's',
      messages: [],
      maxOutputTokens: 10,
    });
    expect(outcome).toMatchObject({
      ok: true,
      provider: { model: 'unpriced-fallback-model' },
      usage: { costUsd: 4 },
    });
    expect(traces.rows[0]).toMatchObject({ model: 'unpriced-fallback-model', costUsd: 4 });
  });

  it('times out after AI_REQUEST_TIMEOUT_MS', async () => {
    const started = Date.now();
    const outcome = await runner(new FakeLlmProvider(), {
      settings: { requestTimeoutMs: 50 },
    }).generateStructured(call(), structured('FAKE-LLM-SLOW'));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(outcome).toMatchObject({ ok: false, failure: 'timeout', errorCode: 'timeout' });
    expect(traces.rows[0]).toMatchObject({ status: 'timeout', errorCode: 'timeout' });
  });

  it('applies the per-user rate limit with a retry-after and a limited trace', async () => {
    const run = runner(new FakeLlmProvider(), { settings: { rateLimitPerUserPerMinute: 2 } });
    const text = { system: 's', messages: [], maxOutputTokens: 10 };
    expect((await run.generateText(call(), text)).ok).toBe(true);
    now = new Date(now.getTime() + 20_000);
    expect((await run.generateText(call(), text)).ok).toBe(true);
    now = new Date(now.getTime() + 10_000);
    const limited = await run.generateText(call(), text);
    expect(limited).toMatchObject({
      ok: false,
      failure: 'rate_limited',
      retryAfterSeconds: 30,
      errorCode: 'rate_limited',
    });
    expect(traces.rows.at(-1)).toMatchObject({ status: 'limited', errorCode: 'rate_limited' });
    // Another user, and a call without a rate-limit key, are not affected.
    expect((await run.generateText(call({ rateLimitKey: 'other-user' }), text)).ok).toBe(true);
    expect((await run.generateText(call({ rateLimitKey: null }), text)).ok).toBe(true);
    // A minute after the first call, the user may call again.
    now = new Date(now.getTime() + 31_000);
    expect((await run.generateText(call(), text)).ok).toBe(true);
  });

  it('applies the daily request limit (the lower of env and organization), not counting limited rows', async () => {
    orgLimits = { dailyRequestLimit: 2, dailyCostLimitUsd: null };
    const run = runner(new FakeLlmProvider(), { settings: { dailyRequestLimit: 5 } });
    const text = { system: 's', messages: [], maxOutputTokens: 10 };
    await run.generateText(call(), text);
    await run.generateText(call(), text);
    for (let i = 0; i < 3; i += 1) {
      expect(await run.generateText(call(), text)).toMatchObject({
        ok: false,
        failure: 'limit_reached',
        errorCode: 'daily_request_limit',
      });
    }
    expect(traces.rows.map((row) => row.status)).toEqual([
      'ok',
      'ok',
      'limited',
      'limited',
      'limited',
    ]);
    // The next UTC day starts from zero.
    now = new Date('2026-11-02T00:00:01.000Z');
    expect((await run.generateText(call(), text)).ok).toBe(true);
    // An environment ceiling lower than the organization's limit wins.
    orgLimits = { dailyRequestLimit: 50, dailyCostLimitUsd: null };
    const strict = runner(new FakeLlmProvider(), { settings: { dailyRequestLimit: 1 } });
    expect(await strict.generateText(call(), text)).toMatchObject({ failure: 'limit_reached' });
  });

  it('applies the daily cost limit from the estimates', async () => {
    const run = runner(new FakeLlmProvider(), { settings: { dailyCostLimitUsd: 0.001 } });
    // The fake prices $10 per million tokens: a 400-character input costs about $0.001.
    const long = {
      system: 's',
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'x'.repeat(400) }] },
      ],
      maxOutputTokens: 10,
    };
    expect((await run.generateText(call(), long)).ok).toBe(true);
    expect(await run.generateText(call(), long)).toMatchObject({
      ok: false,
      failure: 'limit_reached',
      errorCode: 'daily_cost_limit',
    });
  });

  it('is unavailable without a provider and writes no trace', async () => {
    const run = runner(null, { speech: null });
    expect(run.providers()).toEqual({ llm: null, speechToText: null });
    expect(
      await run.generateText(call(), { system: 's', messages: [], maxOutputTokens: 10 }),
    ).toEqual({
      ok: false,
      failure: 'unavailable',
      traceIds: [],
      provider: null,
      errorCode: 'no_provider',
    });
    expect(
      await run.transcribe(call({ prompt: null }), {
        audio: new Uint8Array([1]),
        mimeType: 'audio/mp4',
        fileName: 'capture.m4a',
        languageHint: null,
      }),
    ).toMatchObject({ ok: false, failure: 'unavailable' });
    expect(traces.rows).toEqual([]);
  });

  it('throws for an unknown prompt (a programming error)', async () => {
    await expect(
      runner(new FakeLlmProvider()).generateText(call({ prompt: { id: 'missing', version: 1 } }), {
        system: 's',
        messages: [],
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/missing\.v1\.md was not found/);
  });

  it('transcribes with one trace holding the transcript, duration and cost', async () => {
    const audio = new Uint8Array(Buffer.from(`FAKE-STT:${TRANSCRIPT}`, 'utf8'));
    const outcome = await runner(new FakeLlmProvider()).transcribe(call({ prompt: null }), {
      audio,
      mimeType: 'audio/mp4',
      fileName: 'capture.m4a',
      languageHint: 'tr',
      durationSeconds: 9,
    });
    expect(outcome).toMatchObject({
      ok: true,
      value: { text: TRANSCRIPT, language: 'tr', durationSeconds: 9 },
      usage: { audioSeconds: 9 },
    });
    expect(traces.rows).toHaveLength(1);
    expect(traces.rows[0]).toMatchObject({
      status: 'ok',
      audioSeconds: 9,
      prompt: null,
      output: { text: TRANSCRIPT, language: 'tr', durationSeconds: 9 },
    });
    expect(traces.rows[0]!.inputRefs).toEqual({ subjectType: 'test', subjectId: 'abc' });
  });

  it('records a decision once (idempotent)', async () => {
    const run = runner(new FakeLlmProvider());
    const outcome = await run.generateStructured(call(), structured());
    await run.recordDecision(outcome.traceIds, 'confirmed', USER, now);
    await run.recordDecision(outcome.traceIds, 'discarded', 'someone-else', now);
    expect(traces.rows[0]).toMatchObject({ decision: 'confirmed', decidedById: USER });
  });

  it('never logs a key, a transcript, a prompt or an output', async () => {
    const run = runner(new FakeLlmProvider());
    await run.generateStructured(
      call(),
      structured(`${TRANSCRIPT} FAKE-LLM-JSON: {"count": 1, "note": "${TRANSCRIPT}"}`),
    );
    await run.generateStructured(call(), structured(`${TRANSCRIPT} FAKE-LLM-INVALID`));
    await run.generateStructured(call(), structured(`${TRANSCRIPT} FAKE-LLM-FAIL`));
    await run.transcribe(call({ prompt: null }), {
      audio: new Uint8Array(Buffer.from(`FAKE-STT:${TRANSCRIPT}`)),
      mimeType: 'audio/mp4',
      fileName: 'capture.m4a',
      languageHint: null,
    });
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toContain(SECRET_KEY);
      expect(line).not.toContain('Ayşe');
      expect(line).not.toContain('0532');
      expect(line).not.toContain('You extract counts');
      expect(line).toMatch(/^ai feature=test_feature status=\w+ /);
    }
  });
});
