import { randomUUID } from 'node:crypto';
import { organizationSchema, workLogSchema, zonedDayKey } from '@ops/shared';
import { SummaryScheduler } from '../src/operations/ai/summaries/summary-scheduler';
import {
  AiProviderError,
  LLM_PROVIDER,
  SPEECH_TO_TEXT_PROVIDER,
  type LlmProvider,
  type SpeechToTextProvider,
} from '../src/platform/ai';
import { OutboxConsumer } from '../src/platform/outbox/outbox-consumer';
import {
  at,
  createLogType,
  createMembership,
  createSite,
  createTenant,
  createUser,
  type Tenant,
} from './support/factories';
import { startTestApp, type TestApp } from './support/test-app';

// "AI off -> app fully functional" (Phase 7, ADR-0010 section 1): the core worker, supervisor and
// dashboard flows of Phases 1 to 6 run unchanged in three situations:
//   1. the organization's AI settings are off (the default), with the fake providers present;
//   2. the AI is switched on but no provider is configured (production without keys);
//   3. the AI is switched on and every provider call throws (a provider outage or a bug).
// In each, the AI routes answer their documented refusal (403 ai_disabled, 503 ai_unavailable,
// or a template summary) and nothing else changes. Fictional names only.

const TZ = 'Europe/Istanbul';

/** An LLM whose every call fails: an outage, or a bug in an adapter (a plain TypeError). */
class BrokenLlm implements LlmProvider {
  readonly info = { name: 'broken', model: 'fake-llm-1', fake: true };
  calls = 0;

  generate(): Promise<never> {
    this.calls += 1;
    return Promise.reject(
      this.calls % 2 === 0
        ? new TypeError('Cannot read properties of undefined')
        : new AiProviderError('http_529', 'Overloaded'),
    );
  }

  estimateCostUsd(): number | null {
    return null;
  }
}

class BrokenSpeech implements SpeechToTextProvider {
  readonly info = { name: 'broken', model: 'fake-stt-1', fake: true };

  transcribe(): Promise<never> {
    return Promise.reject(new AiProviderError('network', 'Connection reset'));
  }

  estimateCostUsd(): number | null {
    return null;
  }
}

/** The first bytes of an M4A file and the fake speech-to-text marker. */
function m4a(spoken: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypM4A \u0000\u0000\u0000\u0000', 'latin1'),
      Buffer.from(`FAKE-STT:${spoken}`, 'utf8'),
      Buffer.from([0]),
    ]),
  );
}

interface Situation {
  name: string;
  ai: Record<string, boolean>;
  providers: 'fake' | 'none' | 'broken';
  /** What POST /ai/capture (and processing a voice note) answers. */
  capture: { status: number; code: string };
  /** What POST /ai/summaries/generate answers, and the narrative source when it runs. */
  summary: { status: number; code?: string; source?: 'template' };
}

const SITUATIONS: Situation[] = [
  {
    name: 'AI settings off (the default), fake providers present',
    ai: {},
    providers: 'fake',
    capture: { status: 403, code: 'ai_disabled' },
    summary: { status: 403, code: 'ai_disabled' },
  },
  {
    name: 'AI switched on, no provider configured',
    ai: { smartCaptureEnabled: true, dailySummaryEnabled: true },
    providers: 'none',
    capture: { status: 503, code: 'ai_unavailable' },
    summary: { status: 200, source: 'template' },
  },
  {
    name: 'AI switched on, every provider call fails',
    ai: { smartCaptureEnabled: true, dailySummaryEnabled: true },
    providers: 'broken',
    capture: { status: 503, code: 'ai_unavailable' },
    summary: { status: 200, source: 'template' },
  },
];

describe.each(SITUATIONS)('the core app with $name', (situation) => {
  let ctx: TestApp;
  let tenant: Tenant;
  let consumer: OutboxConsumer;
  let w: {
    orgId: string;
    siteId: string;
    logTypeId: string;
    worker: string;
    supervisor: string;
    manager: string;
  };

  beforeAll(async () => {
    ctx = await startTestApp({
      configure: (builder) => {
        if (situation.providers === 'none') {
          return builder
            .overrideProvider(LLM_PROVIDER)
            .useValue(null)
            .overrideProvider(SPEECH_TO_TEXT_PROVIDER)
            .useValue(null);
        }
        if (situation.providers === 'broken') {
          return builder
            .overrideProvider(LLM_PROVIDER)
            .useValue(new BrokenLlm())
            .overrideProvider(SPEECH_TO_TEXT_PROVIDER)
            .useValue(new BrokenSpeech());
        }
        return builder;
      },
    });
    consumer = ctx.app.get(OutboxConsumer);
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await ctx.reset();
    consumer.resetState();
    tenant = await createTenant(ctx.prisma, 'Core Org');
    const orgId = tenant.organization.id;
    await ctx.prisma.organization.update({
      where: { id: orgId },
      data: { settings: { timeZone: TZ, ai: situation.ai } },
    });
    const site = await createSite(ctx.prisma, orgId, { name: 'East Yard' });
    const logType = await createLogType(ctx.prisma, orgId, { name: 'Inspection' });
    const person = async (role: 'worker' | 'supervisor' | 'manager') => {
      const user = await createUser(ctx.prisma, orgId);
      await createMembership(ctx.prisma, orgId, user.id, role, {
        orgWide: role === 'manager',
        siteIds: role === 'manager' ? [] : [site.id],
      });
      return user.id;
    };
    w = {
      orgId,
      siteId: site.id,
      logTypeId: logType.id,
      worker: await person('worker'),
      supervisor: await person('supervisor'),
      manager: await person('manager'),
    };
  });

  it('runs the worker, supervisor and dashboard flows unchanged', async () => {
    const worker = ctx.as(w.worker);
    const supervisor = ctx.as(w.supervisor);

    // The phone learns which AI features are on from the organization summary.
    const organization = await worker.get('/organization');
    expect(organization.status).toBe(200);
    expect(organizationSchema.safeParse(organization.body).success).toBe(true);
    expect(organization.body.aiFeatures).toEqual({
      smartCapture: situation.ai.smartCaptureEnabled === true,
      dailySummary: situation.ai.dailySummaryEnabled === true,
    });

    // Tasks: create, assign, start.
    const task = await supervisor.post('/tasks', {
      title: 'Replace the filter',
      siteId: w.siteId,
      assigneeIds: [w.worker],
    });
    expect(task.status).toBe(201);
    const started = await worker.patch(`/tasks/${task.body.id}/status`, {
      status: 'in_progress',
    });
    expect(started.status).toBe(200);

    // Work logs: create (and its idempotent repeat), edit, review.
    const body = {
      clientId: randomUUID(),
      occurredAt: at(30).toISOString(),
      siteId: w.siteId,
      taskId: task.body.id,
      logTypeId: w.logTypeId,
      text: 'Filter replaced, pressure normal',
      customFields: { area: 'Pump room', quantity: 2, result: 'ok' },
    };
    const created = await worker.post('/work-logs', body);
    expect(created.status).toBe(201);
    expect(workLogSchema.safeParse(created.body).success).toBe(true);
    expect(created.body).toMatchObject({ source: 'manual', aiMetadata: null, status: 'submitted' });
    expect((await worker.post('/work-logs', body)).status).toBe(200);
    const edited = await worker.patch(`/work-logs/${created.body.id}`, {
      text: 'Filter replaced, pressure normal again',
    });
    expect(edited.status).toBe(200);
    const approved = await supervisor.patch(`/work-logs/${created.body.id}/status`, {
      status: 'approved',
    });
    expect(approved.status).toBe(200);
    expect((await worker.patch(`/tasks/${task.body.id}/status`, { status: 'done' })).status).toBe(
      200,
    );

    // Reads: lists, the dashboard, the phone's pull, an export, a report.
    const list = await supervisor.get('/work-logs', { source: 'manual' });
    expect(list.status).toBe(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([created.body.id]);
    const day = zonedDayKey(at(30), TZ);
    for (const reader of [supervisor, ctx.as(w.manager)]) {
      const overview = await reader.get('/dashboard/overview', { day });
      expect(overview.status).toBe(200);
      expect(overview.body.logsToday.count).toBe(1);
    }
    const pull = await worker.get('/sync/pull');
    expect(pull.status).toBe(200);
    expect(JSON.stringify(pull.body)).toContain(created.body.id);
    const csv = await supervisor.get('/exports/work-logs.csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Filter replaced');
    const report = await ctx.as(w.manager).get('/reports/work-logs', {
      occurredFrom: at(-24 * 60).toISOString(),
      occurredTo: at(24 * 60).toISOString(),
    });
    expect(report.status).toBe(200);

    // Notifications still flow through the outbox consumer.
    await consumer.processPending();
    const inbox = await worker.get('/notifications');
    expect(inbox.status).toBe(200);
    const types = (inbox.body.items as Array<{ type: string }>).map((item) => item.type).sort();
    expect(types).toEqual(['task.assigned', 'work_log.approved']);

    // Nothing of the above touched the AI layer.
    expect(await ctx.prisma.aiTrace.count()).toBe(0);
    expect(await ctx.prisma.smartCapture.count()).toBe(0);
  });

  it('answers smart capture with its documented refusal; the manual log is unaffected', async () => {
    const worker = ctx.as(w.worker);
    const text = await worker.post('/ai/capture', {
      kind: 'text',
      clientId: randomUUID(),
      context: { capturedAt: at(0).toISOString() },
      text: 'Valve replaced at the east pump',
    });
    expect(text.status).toBe(situation.capture.status);
    expect(text.body.code).toBe(situation.capture.code);

    if (situation.capture.status === 503) {
      // A voice note: the bytes are kept, the capture stays pending, the phone may retry.
      const bytes = m4a('Valve replaced');
      const voice = await worker.post('/ai/capture', {
        kind: 'voice',
        clientId: randomUUID(),
        context: { capturedAt: at(0).toISOString() },
        mimeType: 'audio/mp4',
        sizeBytes: bytes.byteLength,
        durationMs: 3000,
      });
      expect(voice.status).toBe(201);
      ctx.storage.uploadTo(voice.body.upload.url, bytes, 'audio/mp4');
      const processed = await worker.post(`/ai/capture/${voice.body.capture.id}/process`);
      expect(processed.status).toBe(503);
      expect(processed.body.code).toBe('ai_unavailable');
      expect((await worker.get(`/ai/capture/${voice.body.capture.id}`)).body.status).toBe(
        'pending',
      );
    }

    // The worker fills the form by hand: an ordinary manual log.
    const manual = await worker.post('/work-logs', {
      clientId: randomUUID(),
      occurredAt: at(0).toISOString(),
      siteId: w.siteId,
      text: 'Valve replaced at the east pump',
    });
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ source: 'manual', aiMetadata: null });
  });

  it('daily summaries: refused while off, a template when the AI cannot write', async () => {
    const response = await ctx.as(tenant.admin.id).post('/ai/summaries/generate', {});
    expect(response.status).toBe(situation.summary.status);
    if (situation.summary.code) {
      expect(response.body.code).toBe(situation.summary.code);
      expect(
        await ctx.app.get(SummaryScheduler).runOnce(new Date(Date.now() + 86_400_000)),
      ).toEqual({ organizations: 0, generated: 0, failed: 0 });
      expect(await ctx.prisma.dailySummary.count()).toBe(0);
      return;
    }
    // Supervisor and manager each get one, written by code.
    expect(response.body).toMatchObject({ generated: 2, failed: 0 });
    for (const reader of [w.supervisor, w.manager]) {
      const summaries = await ctx.as(reader).get('/ai/summaries');
      expect(summaries.status).toBe(200);
      expect(summaries.body.items).toHaveLength(1);
      expect(summaries.body.items[0]).toMatchObject({ narrativeSource: situation.summary.source });
    }
    await consumer.processPending();
    expect(await ctx.prisma.notification.count({ where: { type: 'ai.daily_summary' } })).toBe(2);
  });
});
