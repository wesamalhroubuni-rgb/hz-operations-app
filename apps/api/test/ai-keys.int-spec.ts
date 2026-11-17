import { aiProviderKeysSchema } from '@ops/shared';
import {
  AI_REAL_PROVIDER_FACTORIES,
  AI_RUNNER,
  AiProviderError,
  FakeLlmProvider,
  type AiRunner,
  type RealProviderFactories,
} from '../src/platform/ai';
import { createMembership, createTenant, createUser, type Tenant } from './support/factories';
import { NETWORK_FREE_PROVIDER_FACTORIES, startTestApp, type TestApp } from './support/test-app';

// ADR-0012: an admin stores the organization's own Claude / OpenAI key. The key is checked with
// the provider (scripted here: no network), stored encrypted, never returned, logged, audited or
// published, and used by the AI runner for that organization only. Example keys only.

const VALID_KEY = 'sk-ant-api03-integration-VALID-key-0000wxyz';
const REFUSED_KEY = 'sk-ant-api03-integration-REFUSED-key-00001';
const OUTAGE_KEY = 'sk-ant-api03-integration-OUTAGE-key-000001';
const OPENAI_KEY = 'sk-proj-integration-openai-VALID-key-9876';
const SECRET = 'integration-ai-keys-secret-Qm7Zx2Lp9Wv4Rt8N';

/** Scripted factories: the "provider" accepts keys containing VALID, refuses REFUSED. */
function scriptedFactories(built: string[], checkedModels: string[] = []): RealProviderFactories {
  const check = (apiKey: string, model: string) => {
    checkedModels.push(model);
    if (model === 'claude-fable-5-2' && apiKey.includes('NOFABLE')) {
      return Promise.reject(new AiProviderError('http_404', 'scripted unknown model'));
    }
    return apiKey.includes('VALID')
      ? Promise.resolve()
      : Promise.reject(
          new AiProviderError(
            apiKey.includes('OUTAGE') ? 'http_529' : 'http_401',
            'scripted refusal',
          ),
        );
  };
  return {
    ...NETWORK_FREE_PROVIDER_FACTORIES,
    checkLlmKey: (apiKey, model) => check(apiKey, model),
    checkSpeechToTextKey: (apiKey, model) => check(apiKey, model),
    speechToText: (apiKey, model) => {
      built.push(apiKey);
      return {
        info: { name: 'openai', model, fake: false },
        transcribe: () => Promise.reject(new AiProviderError('network', 'scripted')),
        estimateCostUsd: () => 0,
      };
    },
    llm: (apiKey, model) => {
      built.push(apiKey);
      const fake = new FakeLlmProvider();
      return {
        info: { name: 'anthropic', model, fake: false },
        generate: (request, signal) => fake.generate(request, signal),
        estimateCostUsd: () => 0,
      };
    },
  };
}

describe('AI provider keys (ADR-0012)', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let built: string[];
  const checkedModels: string[] = [];
  const logLines: string[] = [];
  const captureLogger = {
    log: (message: unknown) => void logLines.push(String(message)),
    warn: (message: unknown) => void logLines.push(String(message)),
    error: (message: unknown) => void logLines.push(String(message)),
    debug: (message: unknown) => void logLines.push(String(message)),
    verbose: (message: unknown) => void logLines.push(String(message)),
  };

  beforeAll(async () => {
    built = [];
    ctx = await startTestApp({
      config: { AI_KEYS_ENCRYPTION_SECRET: SECRET },
      logger: captureLogger,
      configure: (builder) =>
        builder
          .overrideProvider(AI_REAL_PROVIDER_FACTORIES)
          .useValue(scriptedFactories(built, checkedModels)),
    });
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await ctx.reset();
    built.length = 0;
    checkedModels.length = 0;
    logLines.length = 0;
    tenant = await createTenant(ctx.prisma, 'Keys Org');
  });

  const admin = () => ctx.as(tenant.admin.id);

  it('starts on the test AI with no stored key', async () => {
    const response = await admin().get('/ai/keys');
    expect(response.status).toBe(200);
    expect(aiProviderKeysSchema.parse(response.body)).toEqual({
      storageAvailable: true,
      keys: [
        {
          provider: 'anthropic',
          source: 'test',
          hint: null,
          updatedAt: null,
          unreadable: false,
          model: expect.any(String),
        },
        {
          provider: 'openai',
          source: 'test',
          hint: null,
          updatedAt: null,
          unreadable: false,
          model: expect.any(String),
        },
      ],
    });
  });

  it('stores a checked key encrypted, shows only its last four characters, and uses it', async () => {
    const saved = await admin().put('/ai/keys/anthropic', { apiKey: VALID_KEY });
    expect(saved.status).toBe(200);
    expect(saved.body.keys[0]).toMatchObject({
      provider: 'anthropic',
      source: 'organization',
      hint: '…wxyz',
    });
    expect(JSON.stringify(saved.body)).not.toContain(VALID_KEY);

    const row = await ctx.prisma.aiProviderKey.findFirstOrThrow({
      where: { organizationId: tenant.organization.id },
    });
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('sk-ant');
    expect(row.updatedById).toBe(tenant.admin.id);

    // The runner uses the organization's key, built once.
    const runner = ctx.app.get<AiRunner>(AI_RUNNER);
    expect(await runner.providers(tenant.organization.id)).toMatchObject({
      llm: { name: 'anthropic', fake: false },
      speechToText: { fake: true },
    });
    expect(built).toEqual([VALID_KEY]);

    // Another organization keeps the server's providers.
    const other = await createTenant(ctx.prisma, 'Other Org');
    expect(await runner.providers(other.organization.id)).toMatchObject({ llm: { fake: true } });
    expect((await ctx.as(other.admin.id).get('/ai/keys')).body.keys[0].source).toBe('test');
  });

  it('never writes the key to the audit log, the outbox or the logs', async () => {
    await admin().put('/ai/keys/anthropic', { apiKey: VALID_KEY });
    await admin().put('/ai/keys/anthropic', { apiKey: `${VALID_KEY}2` });
    await admin().delete('/ai/keys/anthropic');
    const audit = await ctx.prisma.auditEvent.findMany({
      where: { organizationId: tenant.organization.id, entityType: 'ai_provider_key' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((event) => event.action)).toEqual([
      'ai_provider_key.created',
      'ai_provider_key.updated',
      'ai_provider_key.deleted',
    ]);
    const outbox = await ctx.prisma.outboxEvent.findMany({
      where: { organizationId: tenant.organization.id, aggregateType: 'ai_provider_key' },
    });
    expect(outbox).toHaveLength(3);
    const stored = JSON.stringify({ audit, outbox }, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(stored).not.toContain(VALID_KEY);
    expect(stored).not.toContain('wxyz');
    expect(logLines.join('\n')).not.toContain(VALID_KEY);
  });

  it('refuses a key the provider rejects (422) and stores nothing', async () => {
    const response = await admin().put('/ai/keys/anthropic', { apiKey: REFUSED_KEY });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ai_key_invalid');
    expect(JSON.stringify(response.body)).not.toContain(REFUSED_KEY);
    expect(await ctx.prisma.aiProviderKey.count()).toBe(0);
    expect(logLines.join('\n')).not.toContain(REFUSED_KEY);
  });

  it('answers 503 ai_unavailable when the provider cannot be reached, storing nothing', async () => {
    const response = await admin().put('/ai/keys/anthropic', { apiKey: OUTAGE_KEY });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('ai_unavailable');
    expect(await ctx.prisma.aiProviderKey.count()).toBe(0);
  });

  it('validates the body and the provider name', async () => {
    expect((await admin().put('/ai/keys/anthropic', { apiKey: 'short' })).status).toBe(400);
    expect((await admin().put('/ai/keys/anthropic', { apiKey: `${VALID_KEY} x` })).status).toBe(
      400,
    );
    expect((await admin().put('/ai/keys/anthropic', { apiKey: VALID_KEY, extra: 1 })).status).toBe(
      400,
    );
    expect((await admin().put('/ai/keys/gemini', { apiKey: VALID_KEY })).status).toBe(400);
  });

  it('stores an OpenAI key for voice separately, and removing a key falls back', async () => {
    await admin().put('/ai/keys/openai', { apiKey: OPENAI_KEY });
    let status = (await admin().get('/ai/keys')).body;
    expect(status.keys.map((key: { source: string }) => key.source)).toEqual([
      'test',
      'organization',
    ]);
    status = (await admin().delete('/ai/keys/openai')).body;
    expect(status.keys[1]).toMatchObject({ source: 'test', hint: null });
    // Removing again is a no-op.
    expect((await admin().delete('/ai/keys/openai')).status).toBe(200);
  });

  it('is for admins only', async () => {
    for (const role of ['manager', 'supervisor', 'worker'] as const) {
      const user = await createUser(ctx.prisma, tenant.organization.id, { displayName: role });
      await createMembership(ctx.prisma, tenant.organization.id, user.id, role, { orgWide: true });
      const caller = ctx.as(user.id);
      expect((await caller.get('/ai/keys')).status).toBe(403);
      expect((await caller.put('/ai/keys/anthropic', { apiKey: VALID_KEY })).status).toBe(403);
      expect((await caller.delete('/ai/keys/anthropic')).status).toBe(403);
    }
    expect(await ctx.prisma.aiProviderKey.count()).toBe(0);
  });

  const setModel = (ai: Record<string, string>) =>
    ctx.prisma.organization.update({
      where: { id: tenant.organization.id },
      data: { settings: { ai } },
    });

  it("checks the key against the organization's chosen model and uses that model", async () => {
    await setModel({ llmModel: 'claude-sonnet-5-5' });
    expect((await admin().put('/ai/keys/anthropic', { apiKey: VALID_KEY })).status).toBe(200);
    expect(checkedModels).toEqual(['claude-sonnet-5-5']);
    const runner = ctx.app.get<AiRunner>(AI_RUNNER);
    expect(await runner.providers(tenant.organization.id)).toMatchObject({
      llm: { name: 'anthropic', model: 'claude-sonnet-5-5' },
    });
    expect((await admin().get('/ai/keys')).body.keys[0].model).toBe('claude-sonnet-5-5');
    // Choosing another model builds a provider for it with the same key.
    await setModel({ llmModel: 'claude-haiku-5-5' });
    expect(await runner.providers(tenant.organization.id)).toMatchObject({
      llm: { model: 'claude-haiku-5-5' },
    });
  });

  it('explains a key without access to the chosen model (422 with a model detail)', async () => {
    await setModel({ llmModel: 'claude-fable-5-2' });
    const response = await admin().put('/ai/keys/anthropic', {
      apiKey: 'sk-ant-api03-VALID-but-NOFABLE-0000001',
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ai_key_invalid');
    expect(response.body.details).toEqual([
      { path: 'model', message: 'no access to the model claude-fable-5-2' },
    ]);
  });

  it('limits key checks per admin (429 after 5 a minute)', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await admin().put('/ai/keys/anthropic', { apiKey: REFUSED_KEY })).status);
    }
    expect(statuses).toEqual([422, 422, 422, 422, 422, 429]);
  });

  it('reports a stored key it cannot read as unreadable', async () => {
    await admin().put('/ai/keys/anthropic', { apiKey: VALID_KEY });
    // Damage the row as a changed secret would: it no longer decrypts.
    const row = await ctx.prisma.aiProviderKey.findFirstOrThrow();
    const authTag = Uint8Array.from(row.authTag);
    authTag[0] = (authTag[0] ?? 0) ^ 1;
    await ctx.prisma.aiProviderKey.update({ where: { id: row.id }, data: { authTag } });
    const status = (await admin().get('/ai/keys')).body.keys[0];
    expect(status).toMatchObject({ source: 'test', hint: '…wxyz', unreadable: true });
  });

  it('treats a row copied to another organization as no key (it does not decrypt)', async () => {
    await admin().put('/ai/keys/anthropic', { apiKey: VALID_KEY });
    const row = await ctx.prisma.aiProviderKey.findFirstOrThrow();
    const other = await createTenant(ctx.prisma, 'Copy Target');
    await ctx.prisma.aiProviderKey.create({
      data: {
        organizationId: other.organization.id,
        provider: 'anthropic',
        keyVersion: row.keyVersion,
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        hint: row.hint,
        updatedById: other.admin.id,
      },
    });
    const runner = ctx.app.get<AiRunner>(AI_RUNNER);
    expect(await runner.providers(other.organization.id)).toMatchObject({ llm: { fake: true } });
    expect(logLines.join('\n')).toContain('ai key unreadable');
  });
});

describe('AI provider keys without AI_KEYS_ENCRYPTION_SECRET', () => {
  let ctx: TestApp;
  let tenant: Tenant;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma, 'No Secret Org');
  });

  it('reports storage unavailable and refuses to save (503)', async () => {
    const status = await ctx.as(tenant.admin.id).get('/ai/keys');
    expect(status.body.storageAvailable).toBe(false);
    const response = await ctx.as(tenant.admin.id).put('/ai/keys/anthropic', { apiKey: VALID_KEY });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('ai_key_storage_unavailable');
  });
});
