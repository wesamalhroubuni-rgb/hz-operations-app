import {
  addDays,
  anomalyFlagListSchema,
  dailySummaryListSchema,
  dailySummarySchema,
  zonedDayKey,
  zonedDayStart,
  type DailySummary,
} from '@ops/shared';
import { SummariesService } from '../src/operations/ai/summaries/summaries.service';
import { templateNarrative } from '../src/operations/ai/summaries/summary-messages';
import { SummaryScheduler } from '../src/operations/ai/summaries/summary-scheduler';
import {
  AiProviderError,
  FakeLlmProvider,
  LLM_PROVIDER,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../src/platform/ai';
import { NotificationService } from '../src/platform/notifications/notification.service';
import { OutboxConsumer } from '../src/platform/outbox/outbox-consumer';
import {
  createMembership,
  createSite,
  createTask,
  createTenant,
  createUser,
  createWorkLog,
  type Tenant,
} from './support/factories';
import { startTestApp, type Json, type TestApp } from './support/test-app';

// Daily summaries and anomaly flags (Phase 7, ADR-0011) on the real database, with a scripted
// LLM in front of the deterministic fake. Fictional names and places only.
//
//   Org (Europe/Istanbul), daily summaries on
//   sites: North Yard (coordinates), South Depot, Quiet Quarry
//   supA  supervisor of North             supB  supervisor of South and Quiet Quarry
//   mgr   manager (org-wide)              admin (org-wide; not a recipient by default)
//   wA    worker at North                 wB    worker at South
//
//   today: wA 3 logs + 1 log 55 km away at North; wB 2 logs + 3 logs rejected by supB at South
//   yesterday: wA 1 log at North, wB 1 log at South
//   tasks: "Fix north gate" (North, overdue), "Survey quarry" (Quarry, todo), "Unload trucks"
//          (South, blocked)
//   flags: far_location (North, the far log), no_activity_site (Quiet Quarry),
//          repeated_rejections (wB)

const TZ = 'Europe/Istanbul';
const FAIL = '<<fail>>';

/** The fake LLM, unless a test queued answers (or a provider failure) for the next calls. */
class ScriptedLlm implements LlmProvider {
  readonly info = { name: 'fake', model: 'fake-llm-1', fake: true };
  private readonly fake = new FakeLlmProvider();
  answers: string[] = [];
  requests: LlmRequest[] = [];

  generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.answers.shift();
    if (next === undefined) {
      return this.fake.generate(request, signal);
    }
    if (next === FAIL) {
      return Promise.reject(new AiProviderError('http_529', 'The scripted provider is down'));
    }
    return Promise.resolve({
      text: next,
      stopReason: 'end',
      usage: { inputTokens: 100, outputTokens: 20 },
      model: 'fake-llm-1',
      requestId: null,
    });
  }

  estimateCostUsd(usage: { inputTokens: number; outputTokens: number }, model: string) {
    return this.fake.estimateCostUsd(usage, model);
  }

  userTexts(): string[] {
    return this.requests.map((request) =>
      request.messages
        .flatMap((message) => message.content)
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n'),
    );
  }

  reset(): void {
    this.answers = [];
    this.requests = [];
  }
}

interface World {
  day: string;
  yesterday: string;
  north: string;
  south: string;
  quarry: string;
  supA: string;
  supB: string;
  mgr: string;
  wA: string;
  wB: string;
  farLog: string;
  tasks: { north: string; quarry: string; south: string };
}

describe('daily summaries and anomaly flags', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let llm: ScriptedLlm;
  let summaries: SummariesService;
  let scheduler: SummaryScheduler;
  let consumer: OutboxConsumer;
  let w: World;

  beforeAll(async () => {
    llm = new ScriptedLlm();
    ctx = await startTestApp({
      configure: (builder) => builder.overrideProvider(LLM_PROVIDER).useValue(llm),
    });
    summaries = ctx.app.get(SummariesService);
    scheduler = ctx.app.get(SummaryScheduler);
    consumer = ctx.app.get(OutboxConsumer);
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await ctx.reset();
    consumer.resetState();
    llm.reset();
    tenant = await createTenant(ctx.prisma, 'Summary Org');
    w = await build();
  });

  const org = () => tenant.organization.id;
  const admin = () => ctx.as(tenant.admin.id);

  async function setAi(ai: Record<string, unknown>): Promise<void> {
    await ctx.prisma.organization.update({
      where: { id: org() },
      // Summary time 00:00 unless a test sets one: today is then always due, so the generate
      // route's default day is today whatever time the suite runs.
      data: {
        settings: {
          timeZone: TZ,
          ai: { dailySummaryEnabled: true, summaryTime: '00:00', ...ai },
        },
      },
    });
  }

  async function build(): Promise<World> {
    const prisma = ctx.prisma;
    await setAi({});
    const day = zonedDayKey(ctx.clock.now(), TZ);
    const yesterday = addDays(day, -1);
    const minutesInto = (key: string, minutes: number) =>
      new Date(zonedDayStart(key, TZ).getTime() + minutes * 60_000);

    const north = (
      await createSite(prisma, org(), { name: 'North Yard', latitude: 41, longitude: 29 })
    ).id;
    const south = (await createSite(prisma, org(), { name: 'South Depot' })).id;
    const quarry = (await createSite(prisma, org(), { name: 'Quiet Quarry' })).id;

    const person = async (
      displayName: string,
      role: 'worker' | 'supervisor' | 'manager',
      siteIds: string[],
    ) => {
      const user = await createUser(prisma, org(), { displayName });
      await createMembership(prisma, org(), user.id, role, {
        orgWide: role === 'manager',
        siteIds,
      });
      return user.id;
    };
    const supA = await person('Selin Supervisor', 'supervisor', [north]);
    const supB = await person('Burak Supervisor', 'supervisor', [south, quarry]);
    const mgr = await person('Mira Manager', 'manager', []);
    const wA = await person('Ali Worker', 'worker', [north]);
    const wB = await person('Berk Worker', 'worker', [south]);

    const log = (authorId: string, siteId: string, key: string, minutes: number, extra = {}) =>
      createWorkLog(prisma, org(), authorId, {
        siteId,
        occurredAt: minutesInto(key, minutes),
        ...extra,
      });
    for (let i = 0; i < 3; i += 1) {
      await log(wA, north, day, 10 + i);
    }
    const farLog = (await log(wA, north, day, 20, { latitude: 41.5, longitude: 29 })).id;
    for (let i = 0; i < 2; i += 1) {
      await log(wB, south, day, 30 + i);
    }
    const rejectable = [];
    for (let i = 0; i < 3; i += 1) {
      rejectable.push((await log(wB, south, day, 40 + i)).id);
    }
    await log(wA, north, yesterday, 60);
    await log(wB, south, yesterday, 60);

    const tasks = {
      north: (
        await createTask(prisma, org(), supA, {
          title: 'Fix north gate',
          siteId: north,
          status: 'in_progress',
          dueAt: new Date(ctx.clock.now().getTime() - 3 * 86_400_000),
          assigneeIds: [wA],
        })
      ).id,
      quarry: (
        await createTask(prisma, org(), supB, {
          title: 'Survey quarry',
          siteId: quarry,
          assigneeIds: [wB],
        })
      ).id,
      south: (
        await createTask(prisma, org(), supB, {
          title: 'Unload trucks',
          siteId: south,
          status: 'blocked',
          assigneeIds: [wB],
        })
      ).id,
    };

    for (const id of rejectable) {
      const response = await ctx
        .as(supB)
        .patch(`/work-logs/${id}/status`, { status: 'rejected', note: 'Wrong area' });
      expect(response.status).toBe(200);
    }
    return { day, yesterday, north, south, quarry, supA, supB, mgr, wA, wB, farLog, tasks };
  }

  async function generate(body: Record<string, unknown> = {}) {
    const response = await admin().post('/ai/summaries/generate', body);
    expect(response.status).toBe(200);
    return response.body as Json;
  }

  async function summaryOf(userId: string, day = w.day): Promise<DailySummary> {
    const response = await ctx.as(userId).get('/ai/summaries', { from: day, to: day });
    expect(response.status).toBe(200);
    expect(dailySummaryListSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.items).toHaveLength(1);
    return response.body.items[0] as DailySummary;
  }

  describe('scope isolation', () => {
    it("each recipient's summary holds only their own scope: counts, names and flags", async () => {
      expect(await generate()).toMatchObject({ day: w.day, generated: 3, skipped: 0, failed: 0 });

      const a = await summaryOf(w.supA);
      expect(a).toMatchObject({
        recipientId: w.supA,
        day: w.day,
        timeZone: TZ,
        narrative: 'Fake narrative.',
        narrativeSource: 'ai',
        locale: 'en',
        scope: { roles: ['supervisor'], orgWide: false, siteIds: [w.north], teamIds: [] },
      });
      expect(a.stats.logs).toEqual({
        total: 4,
        draft: 0,
        submitted: 4,
        approved: 0,
        rejected: 0,
        aiAssisted: 0,
      });
      expect(a.stats.tasks).toMatchObject({ open: 1, overdue: 1, blocked: 0 });
      expect(a.stats.workers).toEqual({ active: 1, idle: 0 });
      expect(a.stats.bySite.map((row) => row.name)).toEqual(['North Yard']);
      expect(a.anomalies.map((flag) => [flag.kind, flag.workLogId])).toEqual([
        ['far_location', w.farLog],
      ]);
      expect(a.stats.anomalies).toMatchObject({ total: 1, byKind: { far_location: 1 } });
      const aText = JSON.stringify(a);
      for (const foreign of ['South Depot', 'Quiet Quarry', 'Berk', w.south, w.quarry, w.wB]) {
        expect(aText).not.toContain(foreign);
      }

      const b = await summaryOf(w.supB);
      expect(b.stats.logs).toMatchObject({ total: 5, submitted: 2, rejected: 3 });
      expect(b.stats.reviews).toEqual({ approved: 0, rejected: 3 });
      expect(b.stats.tasks).toMatchObject({ open: 2, overdue: 0, blocked: 1 });
      expect(b.stats.bySite.map((row) => row.name).sort()).toEqual(['Quiet Quarry', 'South Depot']);
      expect(b.anomalies.map((flag) => flag.kind).sort()).toEqual([
        'no_activity_site',
        'repeated_rejections',
      ]);
      const bText = JSON.stringify(b);
      for (const foreign of ['North Yard', 'Ali Worker', w.north, w.farLog, w.wA]) {
        expect(bText).not.toContain(foreign);
      }

      const m = await summaryOf(w.mgr);
      expect(m.scope).toMatchObject({ orgWide: true, peopleCount: null });
      expect(m.stats.logs.total).toBe(9);
      expect(m.stats.anomalies.total).toBe(3);

      // Workers and the admin (not a recipient by default) have none.
      expect(await ctx.prisma.dailySummary.count()).toBe(3);
      expect((await ctx.as(w.wA).get('/ai/summaries')).status).toBe(403);
      expect((await admin().get('/ai/summaries')).body.items).toEqual([]);
    });

    it("nobody reads another person's summary, not even an admin (404)", async () => {
      await generate();
      const a = await summaryOf(w.supA);
      const one = await ctx.as(w.supA).get(`/ai/summaries/${a.id}`);
      expect(one.status).toBe(200);
      expect(dailySummarySchema.safeParse(one.body).success).toBe(true);
      expect((await ctx.as(w.supB).get(`/ai/summaries/${a.id}`)).status).toBe(404);
      expect((await ctx.as(w.mgr).get(`/ai/summaries/${a.id}`)).status).toBe(404);
      expect((await admin().get(`/ai/summaries/${a.id}`)).status).toBe(404);
    });

    it('the model gets only the facts of the scope, people as references, no log text', async () => {
      await generate();
      const texts = llm.userTexts();
      expect(texts).toHaveLength(3);
      // supA's facts are the only ones without South Depot, supB's the only ones without North.
      const forA = texts.filter((text) => !text.includes('South Depot'));
      const forB = texts.filter((text) => !text.includes('North Yard'));
      expect(forA).toHaveLength(1);
      expect(forB).toHaveLength(1);
      expect(forA[0]).toContain('North Yard');
      for (const foreign of ['Quiet Quarry', 'Survey quarry', '"person"']) {
        expect(forA[0]).not.toContain(foreign);
      }
      expect(forB[0]).toContain('"person": "P1"');
      for (const text of texts) {
        // No display name, e-mail address or log text ever goes to the model.
        for (const secret of ['Berk Worker', 'Ali Worker', 'Selin', '@example.test', 'Work log ']) {
          expect(text).not.toContain(secret);
        }
        expect(text).toContain('<facts>');
      }
      const traces = await ctx.prisma.aiTrace.findMany();
      expect(traces).toHaveLength(3);
      for (const trace of traces) {
        expect(trace).toMatchObject({
          feature: 'summary_narrative',
          promptId: 'daily-summary-narrative',
          promptVersion: 1,
          requestedById: null,
          status: 'ok',
        });
      }
    });

    it('after a membership change, the next summary follows the new scope', async () => {
      await generate({ recipientId: w.supA });
      expect((await summaryOf(w.supA)).stats.bySite.map((row) => row.name)).toEqual(['North Yard']);

      // supA now supervises South instead of North.
      await ctx.prisma.membership.updateMany({
        where: { userId: w.supA },
        data: { archivedAt: new Date() },
      });
      await createMembership(ctx.prisma, org(), w.supA, 'supervisor', { siteIds: [w.south] });

      await generate({ recipientId: w.supA, day: w.yesterday });
      const later = await summaryOf(w.supA, w.yesterday);
      expect(later.scope.siteIds).toEqual([w.south]);
      expect(later.stats.logs.total).toBe(1);
      // (The open North task supA created stays visible to its creator, without the site's name.)
      expect(later.stats.bySite.map((row) => row.name).filter(Boolean)).toEqual(['South Depot']);
      expect(JSON.stringify(later)).not.toContain('North Yard');
    });

    it('the numbers equal the same person’s dashboard', async () => {
      await generate();
      for (const userId of [w.supA, w.supB, w.mgr]) {
        const summary = await summaryOf(userId);
        const overview = (await ctx.as(userId).get('/dashboard/overview', { day: w.day })).body;
        expect({
          logs: summary.stats.logs.total,
          awaiting: summary.stats.awaitingApproval,
          open: summary.stats.tasks.open,
          overdue: summary.stats.tasks.overdue,
          blocked: summary.stats.tasks.blocked,
          idle: summary.stats.workers.idle,
        }).toEqual({
          logs: overview.logsToday.count,
          awaiting: overview.logsAwaitingApproval.count,
          open: overview.tasksOpen.count,
          overdue: overview.tasksOverdue.count,
          blocked: overview.tasksBlocked.count,
          idle: overview.idleWorkers.total,
        });
      }
    });
  });

  describe('the narrative', () => {
    it('keeps an answer whose numbers are all facts, with names put in after the check', async () => {
      llm.answers = ['P1 had 3 rejections in 7 days; 5 logs were recorded and 1 task is blocked.'];
      await generate({ recipientId: w.supB });
      const b = await summaryOf(w.supB);
      expect(b.narrativeSource).toBe('ai');
      expect(b.narrative).toBe(
        'Berk Worker had 3 rejections in 7 days; 5 logs were recorded and 1 task is blocked.',
      );
    });

    it('a stray number twice gives the template; both attempts are traced', async () => {
      llm.answers = ['There were 987654 logs.', 'Still 987654 logs.'];
      await generate({ recipientId: w.supA });
      const a = await summaryOf(w.supA);
      expect(a.narrativeSource).toBe('template');
      expect(a.narrative).toBe(templateNarrative(a.stats, 'en'));
      const traces = await ctx.prisma.aiTrace.findMany({ orderBy: { attempt: 'asc' } });
      expect(traces.map((trace) => [trace.attempt, trace.status])).toEqual([
        [1, 'invalid_output'],
        [2, 'invalid_output'],
      ]);
      const row = await ctx.prisma.dailySummary.findFirstOrThrow({
        where: { recipientId: w.supA },
      });
      expect([...row.traceIds].sort()).toEqual(traces.map((trace) => trace.id).sort());
    });

    it('an unknown person reference is invalid; a valid retry is kept', async () => {
      llm.answers = ['P7 logged 4 times.', 'North Yard had 4 logs.'];
      await generate({ recipientId: w.supA });
      const a = await summaryOf(w.supA);
      expect(a).toMatchObject({ narrativeSource: 'ai', narrative: 'North Yard had 4 logs.' });
      // The retry carried the reason, written by code.
      expect(llm.userTexts()[1]).toContain('P7');
    });

    it('a failing provider gives the template', async () => {
      llm.answers = [FAIL];
      await generate({ recipientId: w.supA });
      const a = await summaryOf(w.supA);
      expect(a.narrativeSource).toBe('template');
      expect(a.narrative).toContain('Daily summary for');
    });

    it('the daily limit gives the template without a provider call', async () => {
      await setAi({ dailyRequestLimit: 0 });
      await generate({ recipientId: w.supA });
      expect((await summaryOf(w.supA)).narrativeSource).toBe('template');
      expect(llm.requests).toHaveLength(0);
      expect((await ctx.prisma.aiTrace.findFirstOrThrow()).status).toBe('limited');
    });

    it('audit and outbox carry ids, day, source and counts, never the narrative', async () => {
      llm.answers = ['North Yard had 4 logs.'];
      await generate({ recipientId: w.supA });
      const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'daily_summary.created' },
      });
      expect(audit).toMatchObject({
        actorType: 'system',
        metadata: { requestedById: tenant.admin.id },
      });
      const outbox = await ctx.prisma.outboxEvent.findFirstOrThrow({
        where: { eventType: 'daily_summary.created' },
      });
      for (const payload of [audit.after, outbox.payload]) {
        const text = JSON.stringify(payload);
        expect(text).not.toContain('North Yard');
        expect(text).not.toContain('narrative"');
        expect(text).toContain('"narrativeSource":"ai"');
      }
    });
  });

  describe('switches, idempotency and recipients', () => {
    it('feature off: nothing is generated, by the route, the service or the scheduler', async () => {
      await ctx.prisma.organization.update({
        where: { id: org() },
        data: { settings: { timeZone: TZ, ai: { dailySummaryEnabled: false } } },
      });
      const response = await admin().post('/ai/summaries/generate', {});
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('ai_disabled');
      expect(await summaries.generateForDay(org(), w.day)).toMatchObject({ generated: 0 });
      expect(await scheduler.runOnce()).toEqual({ organizations: 0, generated: 0, failed: 0 });
      expect(await ctx.prisma.dailySummary.count()).toBe(0);
      expect(await ctx.prisma.anomalyFlag.count()).toBe(0);
      expect(await ctx.prisma.aiTrace.count()).toBe(0);
    });

    it('is idempotent per recipient and day, also when two runs race', async () => {
      const [first, second] = await Promise.all([
        summaries.generateForDay(org(), w.day),
        summaries.generateForDay(org(), w.day),
      ]);
      expect(first.generated + second.generated).toBe(3);
      expect(first.failed + second.failed).toBe(0);
      expect(await ctx.prisma.dailySummary.count()).toBe(3);
      const flags = await ctx.prisma.anomalyFlag.count();
      expect(flags).toBe(3);

      expect(await generate()).toMatchObject({ generated: 0, skipped: 3, summaryIds: [] });
      expect(await ctx.prisma.dailySummary.count()).toBe(3);
      expect(await ctx.prisma.anomalyFlag.count()).toBe(flags);
    });

    it('recipients by role: never workers; archived users and memberships do not count', async () => {
      await setAi({ summaryRecipientRoles: ['admin'] });
      expect(await generate()).toMatchObject({ generated: 1 });
      expect((await ctx.prisma.dailySummary.findFirstOrThrow()).recipientId).toBe(tenant.admin.id);

      await setAi({ summaryRecipientRoles: ['supervisor'] });
      await ctx.prisma.user.update({ where: { id: w.supB }, data: { archivedAt: new Date() } });
      const formerSupervisor = await createUser(ctx.prisma, org());
      await createMembership(ctx.prisma, org(), formerSupervisor.id, 'supervisor', {
        siteIds: [w.north],
        archivedAt: new Date(),
      });
      expect(await generate()).toMatchObject({ generated: 1 });
      const recipients = (await ctx.prisma.dailySummary.findMany()).map((row) => row.recipientId);
      expect(recipients.sort()).toEqual([tenant.admin.id, w.supA].sort());
    });

    it('the generate route checks the day and the recipient', async () => {
      const post = (body: Record<string, unknown>) => admin().post('/ai/summaries/generate', body);
      expect((await post({ day: addDays(w.day, 1) })).status).toBe(422);
      expect((await post({ day: addDays(w.day, -8) })).status).toBe(422);
      expect((await post({ day: addDays(w.day, -7) })).status).toBe(200);
      expect((await post({ recipientId: w.wA })).status).toBe(422);
      expect((await post({ unknown: true })).status).toBe(400);
    });

    it('defaults to the last due day; today before the summary time is refused (422)', async () => {
      const dayStart = zonedDayStart(w.day, TZ);
      const localTime = (hours: number, minutes = 0) =>
        new Date(dayStart.getTime() + (hours * 60 + minutes) * 60_000);
      await setAi({ summaryTime: '18:00' });
      ctx.clock.freeze(localTime(12));

      const early = await admin().post('/ai/summaries/generate', { day: w.day });
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('unprocessable');
      // No day: yesterday, the last day whose summaries are due.
      expect(await generate({ recipientId: w.supA })).toMatchObject({
        day: w.yesterday,
        generated: 1,
      });
      expect(await ctx.prisma.dailySummary.count({ where: { day: new Date(w.day) } })).toBe(0);

      // The scheduled run at the summary time still writes today's summaries.
      expect(await scheduler.runOnce(localTime(18, 5))).toMatchObject({ generated: 3 });
      expect(await ctx.prisma.dailySummary.count({ where: { day: new Date(w.day) } })).toBe(3);
    });
  });

  describe('overdue tasks', () => {
    it('a task due later on the day is not overdue while the day is running', async () => {
      const dayStart = zonedDayStart(w.day, TZ);
      ctx.clock.freeze(new Date(dayStart.getTime() + 12 * 3_600_000));
      await createTask(ctx.prisma, org(), w.supB, {
        title: 'Weigh loads',
        siteId: w.quarry,
        dueAt: new Date(dayStart.getTime() + 15 * 3_600_000),
        assigneeIds: [w.wB],
      });
      expect(await summaries.generateForDay(org(), w.day, { recipientId: w.supB })).toMatchObject({
        generated: 1,
        failed: 0,
      });
      ctx.clock.reset();
      const b = await summaryOf(w.supB);
      expect(b.stats.tasks).toMatchObject({ open: 3, overdue: 0, blocked: 1 });
      // Quiet Quarry has no log today and no overdue task (yet): medium, not high.
      const flag = await ctx.prisma.anomalyFlag.findFirstOrThrow({
        where: { kind: 'no_activity_site', siteId: w.quarry },
      });
      expect(flag.severity).toBe('medium');
    });
  });

  describe('the notification', () => {
    it('notifies the recipient once, in-app in full and with a generic push', async () => {
      const notify = jest.spyOn(ctx.app.get(NotificationService), 'notify');
      try {
        await ctx.prisma.user.update({ where: { id: w.supA }, data: { locale: 'tr' } });
        const { summaryIds } = await generate({ recipientId: w.supA });
        await consumer.processPending();

        const rows = await ctx.prisma.notification.findMany({
          where: { type: 'ai.daily_summary' },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          recipientId: w.supA,
          title: `Daily summary for ${w.day}`,
          data: { summaryId: summaryIds[0], day: w.day },
        });
        expect(rows[0]!.body).toContain('4 work logs');
        const call = notify.mock.calls.find(([input]) => input.type === 'ai.daily_summary')!;
        expect(call[0].push).toEqual({
          title: 'Daily summary',
          body: 'Your daily summary is ready.',
        });
        const event = await ctx.prisma.outboxEvent.findFirstOrThrow({
          where: { eventType: 'daily_summary.created' },
        });
        expect(call[0].sourceEventId).toBe(event.id);

        // Re-processing (a restart, a second instance) writes nothing new.
        consumer.resetState();
        await consumer.processPending();
        expect(await ctx.prisma.notification.count({ where: { type: 'ai.daily_summary' } })).toBe(
          1,
        );
      } finally {
        notify.mockRestore();
      }
    });
  });

  describe('anomaly flags', () => {
    const list = async (userId: string, query: Record<string, string> = {}) => {
      const response = await ctx.as(userId).get('/ai/anomalies', { pageSize: 100, ...query });
      expect(response.status).toBe(200);
      expect(anomalyFlagListSchema.safeParse(response.body).success).toBe(true);
      return response.body.items as Array<Record<string, unknown>>;
    };

    it('a reader sees a flag only when every subject on it is visible', async () => {
      await generate();
      // A flag on North Yard about wB: supA sees North but not wB, supB sees wB but not North.
      await ctx.prisma.anomalyFlag.create({
        data: {
          organizationId: org(),
          day: new Date(`${w.day}T00:00:00.000Z`),
          kind: 'repeated_rejections',
          severity: 'medium',
          siteId: w.north,
          userId: w.wB,
          params: { rejections: 3, windowDays: 7 },
          fingerprint: 'test-mixed-subjects',
        },
      });
      const kinds = (items: Array<Record<string, unknown>>) =>
        items
          .map((item) => `${item.kind as string}:${(item.siteId ?? item.userId) as string}`)
          .sort();
      expect(kinds(await list(w.supA))).toEqual([`far_location:${w.north}`]);
      expect(kinds(await list(w.supB))).toEqual(
        [`no_activity_site:${w.quarry}`, `repeated_rejections:${w.wB}`].sort(),
      );
      expect(await list(w.mgr)).toHaveLength(4);
      expect(await list(tenant.admin.id)).toHaveLength(4);
      expect((await ctx.as(w.wA).get('/ai/anomalies')).status).toBe(403);
    });

    it('stores the reasons as numbers, filters by kind and day range', async () => {
      await generate();
      const [quarry] = await list(w.mgr, { kind: 'no_activity_site' });
      expect(quarry).toMatchObject({
        siteId: w.quarry,
        severity: 'medium',
        params: { lookbackDays: 14, openTasks: 1, lastLogAt: null },
      });
      const [rejections] = await list(w.mgr, { kind: 'repeated_rejections' });
      expect(rejections).toMatchObject({ userId: w.wB, params: { rejections: 3, windowDays: 7 } });
      const [far] = await list(w.mgr, { kind: 'far_location' });
      expect(far).toMatchObject({
        workLogId: w.farLog,
        siteId: w.north,
        severity: 'medium',
        params: { thresholdKm: 2, reference: 'site_coordinates', sampleSize: null },
      });
      expect(await list(w.mgr, { from: w.yesterday, to: w.yesterday })).toEqual([]);
      const bad = (query: Record<string, string>) =>
        ctx
          .as(w.mgr)
          .get('/ai/anomalies', query)
          .then((response) => response.status);
      expect(await bad({ from: w.day, to: w.yesterday })).toBe(400);
      expect(await bad({ from: addDays(w.day, -100), to: w.day })).toBe(400);
    });
  });

  describe('the scheduler', () => {
    it('generates once the summary time has passed, only for that local day', async () => {
      const dayStart = zonedDayStart(w.day, TZ);
      await setAi({ summaryTime: '18:00' });
      // 12:00 local: not yet.
      expect(await scheduler.runOnce(new Date(dayStart.getTime() + 12 * 3_600_000))).toEqual({
        organizations: 0,
        generated: 0,
        failed: 0,
      });
      // 01:00 local the next day: the missed day is not caught up.
      const nextNight = new Date(zonedDayStart(addDays(w.day, 1), TZ).getTime() + 3_600_000);
      expect((await scheduler.runOnce(nextNight)).generated).toBe(0);
      expect(await ctx.prisma.dailySummary.count()).toBe(0);
      // 18:05 local: due; a second wake-up the same evening finds nothing left to do.
      const evening = new Date(dayStart.getTime() + (18 * 60 + 5) * 60_000);
      expect(await scheduler.runOnce(evening)).toMatchObject({ organizations: 1, generated: 3 });
      expect(await scheduler.runOnce(evening)).toMatchObject({ organizations: 1, generated: 0 });
      expect(
        (await ctx.prisma.dailySummary.findMany()).map((row) => row.day.toISOString().slice(0, 10)),
      ).toEqual([w.day, w.day, w.day]);
    });
  });
});

describe('daily summaries without an LLM provider', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await startTestApp({
      configure: (builder) => builder.overrideProvider(LLM_PROVIDER).useValue(null),
    });
  });
  afterAll(() => ctx.close());

  it('falls back to the template and still notifies', async () => {
    await ctx.reset();
    const tenant = await createTenant(ctx.prisma);
    await ctx.prisma.organization.update({
      where: { id: tenant.organization.id },
      data: { settings: { ai: { dailySummaryEnabled: true, summaryRecipientRoles: ['admin'] } } },
    });
    const response = await ctx.as(tenant.admin.id).post('/ai/summaries/generate', {});
    expect(response.status).toBe(200);
    expect(response.body.generated).toBe(1);
    const summary = (await ctx.as(tenant.admin.id).get('/ai/summaries')).body.items[0];
    expect(summary).toMatchObject({ narrativeSource: 'template' });
    expect(summary.narrative).toContain('No work logs were recorded.');
    await ctx.app.get(OutboxConsumer).processPending();
    expect(await ctx.prisma.notification.count({ where: { type: 'ai.daily_summary' } })).toBe(1);
  });
});
