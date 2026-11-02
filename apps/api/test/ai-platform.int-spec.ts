import { aiUsageReportSchema } from '@ops/shared';
import { z } from 'zod';
import {
  AI_RUNNER,
  type AiCall,
  type AiRunner,
  AI_USAGE_READER,
  type AiUsageReader,
} from '../src/platform/ai';
import {
  createMembership,
  createSite,
  createTenant,
  createUser,
  type Tenant,
} from './support/factories';
import { startTestApp, type TestApp } from './support/test-app';

// The AI platform layer on the real database, with the deterministic fake providers (the
// harness sets no API keys, so AI_PROVIDER=auto picks the fakes): one AiTrace row per provider
// call or limit refusal, the daily
// limits counted from real rows (the lower of the environment and the organization), and
// GET /ai/usage for admins only. Example values only.

const DAY_MS = 86_400_000;
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

describe('AI platform layer', () => {
  let ctx: TestApp;
  let runner: AiRunner;
  let usage: AiUsageReader;
  let tenant: Tenant;

  beforeAll(async () => {
    ctx = await startTestApp();
    runner = ctx.app.get<AiRunner>(AI_RUNNER);
    usage = ctx.app.get<AiUsageReader>(AI_USAGE_READER);
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma, 'AI Org');
  });

  const call = (overrides: Partial<AiCall> = {}): AiCall => ({
    organizationId: tenant.organization.id,
    feature: 'summary_narrative',
    requestedById: tenant.admin.id,
    rateLimitKey: tenant.admin.id,
    prompt: null,
    inputRefs: { subjectType: 'test', subjectId: tenant.organization.id, count: 3 },
    ...overrides,
  });
  const text = (content = 'Write the narrative.') => ({
    system: 'You write short narratives.',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: content }] }],
    maxOutputTokens: 200,
  });
  const setAiSettings = (ai: Record<string, number | boolean | string>) =>
    ctx.prisma.organization.update({
      where: { id: tenant.organization.id },
      data: { settings: { ai } },
    });

  it('runs on the fakes and writes one trace row per call', async () => {
    expect(runner.providers()).toEqual({
      llm: { name: 'fake', model: 'fake-llm-1', fake: true },
      speechToText: { name: 'fake', model: 'fake-stt-1', fake: true },
    });
    const outcome = await runner.generateText(call(), text());
    expect(outcome).toMatchObject({ ok: true, value: 'Fake narrative.' });

    const rows = await ctx.prisma.aiTrace.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(outcome.traceIds).toEqual([row.id]);
    expect(row).toMatchObject({
      organizationId: tenant.organization.id,
      feature: 'summary_narrative',
      provider: 'fake',
      model: 'fake-llm-1',
      promptId: null,
      promptVersion: null,
      attempt: 1,
      inputRefs: { subjectType: 'test', subjectId: tenant.organization.id, count: 3 },
      output: 'Fake narrative.',
      status: 'ok',
      errorCode: null,
      requestedById: tenant.admin.id,
      decision: null,
    });
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBe(4);
    expect(Number(row.costEstimateUsd)).toBeGreaterThan(0);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('traces both attempts of an invalid answer, and a transcription', async () => {
    const outcome = await runner.generateStructured(call({ feature: 'capture_extraction' }), {
      ...text('FAKE-LLM-INVALID'),
      schema: z.object({ value: z.string() }),
      schemaName: 'value',
    });
    expect(outcome).toMatchObject({ ok: false, failure: 'invalid_output' });
    const transcription = await runner.transcribe(call({ feature: 'capture_transcription' }), {
      audio: new Uint8Array(Buffer.from('FAKE-STT:Boru değişti')),
      mimeType: 'audio/mp4',
      fileName: 'capture.m4a',
      languageHint: 'tr',
      durationSeconds: 4,
    });
    expect(transcription).toMatchObject({ ok: true, value: { text: 'Boru değişti' } });

    const rows = await ctx.prisma.aiTrace.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => [row.feature, row.attempt, row.status, row.errorCode])).toEqual([
      ['capture_extraction', 1, 'invalid_output', 'unparsable_json'],
      ['capture_extraction', 2, 'invalid_output', 'unparsable_json'],
      ['capture_transcription', 1, 'ok', null],
    ]);
    expect(rows[0]!.output).toBeNull();
    expect(rows[2]).toMatchObject({ audioSeconds: 4, model: 'fake-stt-1' });
  });

  it('stamps a decision once', async () => {
    const outcome = await runner.generateText(call(), text());
    const decidedAt = new Date();
    await runner.recordDecision(outcome.traceIds, 'confirmed', tenant.admin.id, decidedAt);
    await runner.recordDecision(outcome.traceIds, 'discarded', tenant.admin.id, new Date());
    const row = await ctx.prisma.aiTrace.findUniqueOrThrow({ where: { id: outcome.traceIds[0] } });
    expect(row).toMatchObject({ decision: 'confirmed', decidedById: tenant.admin.id, decidedAt });
  });

  it("applies the organization's daily request limit to real rows, not counting limited ones, yesterday or other organizations", async () => {
    await setAiSettings({ dailyRequestLimit: 2 });
    const other = await createTenant(ctx.prisma, 'Other Org');
    const yesterday = new Date(Date.now() - DAY_MS);
    await ctx.prisma.aiTrace.createMany({
      data: [
        // Yesterday's calls and another organization's calls do not count today.
        ...[1, 2, 3].map(() => ({
          organizationId: tenant.organization.id,
          feature: 'summary_narrative',
          provider: 'fake',
          model: 'fake-llm-1',
          status: 'ok' as const,
          createdAt: yesterday,
        })),
        ...[1, 2, 3].map(() => ({
          organizationId: other.organization.id,
          feature: 'summary_narrative',
          provider: 'fake',
          model: 'fake-llm-1',
          status: 'ok' as const,
        })),
        // A limited row today does not count either.
        {
          organizationId: tenant.organization.id,
          feature: 'summary_narrative',
          provider: 'fake',
          model: 'fake-llm-1',
          status: 'limited' as const,
          errorCode: 'daily_request_limit',
        },
      ],
    });

    expect((await runner.generateText(call(), text())).ok).toBe(true);
    expect((await runner.generateText(call({ rateLimitKey: null }), text())).ok).toBe(true);
    const refused = await runner.generateText(call(), text());
    expect(refused).toMatchObject({
      ok: false,
      failure: 'limit_reached',
      errorCode: 'daily_request_limit',
    });
    const limitedRow = await ctx.prisma.aiTrace.findUniqueOrThrow({
      where: { id: refused.traceIds[0] },
    });
    expect(limitedRow).toMatchObject({ status: 'limited', provider: 'fake', model: 'fake-llm-1' });
    expect(await usage.today(tenant.organization.id, new Date())).toMatchObject({ requests: 2 });

    // Raising the organization's limit lets calls through again; the environment's ceiling
    // (500 in the harness) still applies above it.
    await setAiSettings({ dailyRequestLimit: 3 });
    expect((await runner.generateText(call(), text())).ok).toBe(true);
    // The other organization is not limited by this one's usage.
    expect(
      (await runner.generateText(call({ organizationId: other.organization.id }), text())).ok,
    ).toBe(true);
  });

  it("applies the organization's daily cost limit to the estimated cost", async () => {
    await setAiSettings({ dailyCostLimitUsd: 0.0001 });
    // The fake costs $10 per million tokens: about 400 characters reach $0.001.
    expect((await runner.generateText(call(), text('x'.repeat(400)))).ok).toBe(true);
    expect(await runner.generateText(call(), text())).toMatchObject({
      ok: false,
      failure: 'limit_reached',
      errorCode: 'daily_cost_limit',
    });
    const today = await usage.today(tenant.organization.id, new Date());
    expect(today.requests).toBe(1);
    expect(today.costUsd).toBeGreaterThanOrEqual(0.0001);
  });

  describe('GET /ai/usage', () => {
    it('answers admins with rows per day, feature, provider and model, totals and limits', async () => {
      await setAiSettings({ dailyRequestLimit: 50, dailyCostLimitUsd: 20 });
      await runner.generateText(call(), text());
      await runner.generateText(call(), text('FAKE-LLM-FAIL'));
      await runner.generateStructured(call({ feature: 'capture_extraction' }), {
        ...text('FAKE-LLM-INVALID'),
        schema: z.object({ value: z.string() }),
        schemaName: 'value',
      });
      const other = await createTenant(ctx.prisma, 'Other Org');
      await runner.generateText(call({ organizationId: other.organization.id }), text());
      const older = new Date(Date.now() - 40 * DAY_MS);
      await ctx.prisma.aiTrace.create({
        data: {
          organizationId: tenant.organization.id,
          feature: 'summary_narrative',
          provider: 'fake',
          model: 'fake-llm-1',
          status: 'ok',
          createdAt: older,
        },
      });

      const response = await ctx.as(tenant.admin.id).get('/ai/usage');
      expect(response.status).toBe(200);
      const report = aiUsageReportSchema.parse(response.body);
      const today = utcDay(new Date());
      expect(report.to).toBe(today);
      expect(report.from).toBe(utcDay(new Date(Date.now() - 29 * DAY_MS)));
      expect(report.rows).toEqual([
        expect.objectContaining({
          day: today,
          feature: 'capture_extraction',
          provider: 'fake',
          model: 'fake-llm-1',
          requests: 2,
          ok: 0,
          invalidOutput: 2,
        }),
        expect.objectContaining({
          day: today,
          feature: 'summary_narrative',
          requests: 2,
          ok: 1,
          failed: 1,
        }),
      ]);
      expect(report.totals).toMatchObject({ requests: 4, ok: 1, invalidOutput: 2, failed: 1 });
      expect(report.today).toMatchObject({ day: today, requests: 4 });
      expect(report.limits).toEqual({
        dailyRequestLimit: 50,
        dailyCostLimitUsd: 10,
        envDailyRequestLimit: 500,
        envDailyCostLimitUsd: 10,
        rateLimitPerUserPerMinute: 6,
      });
      expect(report.providers).toEqual({
        llm: { name: 'fake', model: 'fake-llm-1' },
        speechToText: { name: 'fake', model: 'fake-stt-1' },
      });

      // An explicit range reaches the older row.
      const older40 = utcDay(older);
      const ranged = await ctx.as(tenant.admin.id).get('/ai/usage', { from: older40, to: older40 });
      expect(ranged.status).toBe(200);
      expect(ranged.body.rows).toHaveLength(1);
      expect(ranged.body.rows[0]).toMatchObject({ day: older40, requests: 1 });
    });

    it('refuses a reversed range, a range over 92 days and a malformed day', async () => {
      const admin = ctx.as(tenant.admin.id);
      expect((await admin.get('/ai/usage', { from: '2026-10-02', to: '2026-10-01' })).status).toBe(
        400,
      );
      expect((await admin.get('/ai/usage', { from: '2026-01-01', to: '2026-04-03' })).status).toBe(
        400,
      );
      expect((await admin.get('/ai/usage', { from: '2026-01-01', to: '2026-04-02' })).status).toBe(
        200,
      );
      expect((await admin.get('/ai/usage', { from: '01/10/2026' })).status).toBe(400);
    });

    it('is for admins only', async () => {
      const site = await createSite(ctx.prisma, tenant.organization.id);
      const statuses: Record<string, number> = {};
      for (const role of ['manager', 'supervisor', 'worker'] as const) {
        const user = await createUser(ctx.prisma, tenant.organization.id);
        await createMembership(ctx.prisma, tenant.organization.id, user.id, role, {
          orgWide: role === 'manager',
          siteIds: role === 'manager' ? [] : [site.id],
        });
        statuses[role] = (await ctx.as(user.id).get('/ai/usage')).status;
      }
      statuses.admin = (await ctx.as(tenant.admin.id).get('/ai/usage')).status;
      statuses.anonymous = (await ctx.as().get('/ai/usage')).status;
      expect(statuses).toEqual({
        manager: 403,
        supervisor: 403,
        worker: 403,
        admin: 200,
        anonymous: 401,
      });
    });
  });
});
