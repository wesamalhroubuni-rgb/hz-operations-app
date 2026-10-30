import { randomUUID } from 'node:crypto';
import {
  bulkWorkLogStatusResultSchema,
  dashboardOverviewSchema,
  directorySchema,
  recordHistorySchema,
  workLogMapSchema,
  workLogReportSchema,
} from '@ops/shared';
import { AuditService } from '../src/platform/audit/audit.service';
import { OutboxConsumer } from '../src/platform/outbox/outbox-consumer';
import {
  createMembership,
  createSite,
  createTask,
  createTenant,
  createUser,
  createWorkLog,
} from './support/factories';
import { startTestApp, type Json, type TestApp } from './support/test-app';

// Phase 6 API additions (ADR-0009), scope-checked per role:
//
//   Org (Europe/Istanbul, UTC+3)  sites S1, S2
//   sup  supervisor of S1         wA worker at S1        wB worker at S2
//   mgr  manager (org-wide)       admin (org-wide)
//
//   logA1  wA, S1, 2026-10-20T20:30Z = 23:30 Istanbul on the 20th, located
//   logA2  wA, S1, 2026-10-20T21:30Z = 00:30 Istanbul on the 21st
//   logB1  wB, S2, 2026-10-20T10:00Z, located
//   tOver  S1, todo, due 3 days ago (overdue)     tBlock  S2, blocked     tDone  S1, done, due past

const DAY = '2026-10-20';
const DAY_MS = 86_400_000;

describe('Phase 6 dashboard API', () => {
  let ctx: TestApp;
  let orgId: string;
  let s1: string;
  let s2: string;
  let sup: string;
  let wA: string;
  let wB: string;
  let mgr: string;
  let admin: string;
  let logA1: string;
  let logA2: string;
  let logB1: string;
  let tOver: string;
  let tBlock: string;
  let tDone: string;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await ctx.reset();
    const tenant = await createTenant(ctx.prisma);
    orgId = tenant.organization.id;
    admin = tenant.admin.id;
    await ctx.prisma.organization.update({
      where: { id: orgId },
      data: { settings: { timeZone: 'Europe/Istanbul' } },
    });
    s1 = (await createSite(ctx.prisma, orgId, { name: 'North' })).id;
    s2 = (await createSite(ctx.prisma, orgId, { name: 'South' })).id;
    sup = (await createUser(ctx.prisma, orgId, { displayName: 'Selin' })).id;
    await createMembership(ctx.prisma, orgId, sup, 'supervisor', { siteIds: [s1] });
    wA = (await createUser(ctx.prisma, orgId, { displayName: 'Ali' })).id;
    await createMembership(ctx.prisma, orgId, wA, 'worker', { siteIds: [s1] });
    wB = (await createUser(ctx.prisma, orgId, { displayName: 'Berk' })).id;
    await createMembership(ctx.prisma, orgId, wB, 'worker', { siteIds: [s2] });
    mgr = (await createUser(ctx.prisma, orgId, { displayName: 'Mert' })).id;
    await createMembership(ctx.prisma, orgId, mgr, 'manager', { orgWide: true });

    logA1 = (
      await createWorkLog(ctx.prisma, orgId, wA, {
        siteId: s1,
        occurredAt: new Date('2026-10-20T20:30:00Z'),
        latitude: 41.01,
        longitude: 28.97,
        text: 'Checked the pump',
      })
    ).id;
    logA2 = (
      await createWorkLog(ctx.prisma, orgId, wA, {
        siteId: s1,
        occurredAt: new Date('2026-10-20T21:30:00Z'),
        text: 'Night round',
      })
    ).id;
    logB1 = (
      await createWorkLog(ctx.prisma, orgId, wB, {
        siteId: s2,
        occurredAt: new Date('2026-10-20T10:00:00Z'),
        latitude: 40.0,
        longitude: 29.0,
        text: 'South fence',
      })
    ).id;
    const past = new Date(Date.now() - 3 * DAY_MS);
    tOver = (
      await createTask(ctx.prisma, orgId, admin, { siteId: s1, dueAt: past, assigneeIds: [wA] })
    ).id;
    tBlock = (
      await createTask(ctx.prisma, orgId, admin, {
        siteId: s2,
        status: 'blocked',
        statusReason: 'No parts',
      })
    ).id;
    tDone = (
      await createTask(ctx.prisma, orgId, admin, { siteId: s1, status: 'done', dueAt: past })
    ).id;
  });

  const as = (userId: string) => ctx.as(userId);

  describe('GET /dashboard/overview', () => {
    it('counts the day in the organization time zone (23:30 Istanbul is the same day)', async () => {
      const response = await as(mgr).get('/dashboard/overview', { day: DAY });
      expect(response.status).toBe(200);
      const body = dashboardOverviewSchema.parse(response.body);
      expect(body.timeZone).toBe('Europe/Istanbul');
      expect(body.dayStart).toBe('2026-10-19T21:00:00.000Z');
      expect(body.dayEnd).toBe('2026-10-20T21:00:00.000Z');
      expect(body.logsToday.count).toBe(2); // logA1 and logB1; logA2 is the 21st there
      expect(body.logsToday.filter).toEqual({
        occurredFrom: '2026-10-19T21:00:00.000Z',
        occurredTo: '2026-10-20T21:00:00.000Z',
      });
      const next = await as(mgr).get('/dashboard/overview', { day: '2026-10-21' });
      expect(next.body.logsToday.count).toBe(1);
    });

    it('counts all three logs on the 20th when the organization is on UTC', async () => {
      await ctx.prisma.organization.update({
        where: { id: orgId },
        data: { settings: { timeZone: 'UTC' } },
      });
      const body = (await as(mgr).get('/dashboard/overview', { day: DAY })).body;
      expect(body.logsToday.count).toBe(3);
    });

    it('gives a manager everything and a supervisor only their site', async () => {
      const manager = (await as(mgr).get('/dashboard/overview', { day: DAY })).body;
      expect(manager.logsAwaitingApproval).toEqual({
        count: 3,
        filter: { status: 'submitted', excludeOwn: 'true' },
      });
      expect(manager.tasksOpen.count).toBe(2);
      expect(manager.tasksOverdue).toEqual({ count: 1, filter: { overdue: 'true' } });
      expect(manager.tasksBlocked.count).toBe(1);
      expect(manager.bySite.map((row: Json) => [row.name, row.logsToday, row.tasksOpen])).toEqual([
        ['North', 1, 1],
        ['South', 1, 1],
      ]);

      const supervisor = (await as(sup).get('/dashboard/overview', { day: DAY })).body;
      expect(supervisor.logsToday.count).toBe(1);
      expect(supervisor.logsAwaitingApproval.count).toBe(2);
      expect(supervisor.tasksOpen.count).toBe(1);
      expect(supervisor.tasksBlocked.count).toBe(0);
      expect(supervisor.bySite.map((row: Json) => row.id)).toEqual([s1]);
      expect(JSON.stringify(supervisor)).not.toContain(s2);
    });

    it('leaves the caller’s own logs out of the review queue, and so does its link', async () => {
      await createWorkLog(ctx.prisma, orgId, sup, { siteId: s1 });
      const body = (await as(sup).get('/dashboard/overview', { day: DAY })).body;
      expect(body.logsAwaitingApproval.count).toBe(2);
      const list = await as(sup).get('/work-logs', body.logsAwaitingApproval.filter);
      expect(list.body.total).toBe(2);
      expect((list.body.items as Json[]).every((item) => item.authorId !== sup)).toBe(true);
      expect((await as(sup).get('/work-logs', { status: 'submitted' })).body.total).toBe(3);
    });

    it('lists idle workers among the caller’s people only', async () => {
      const manager = (await as(mgr).get('/dashboard/overview', { day: '2026-10-19' })).body;
      expect(manager.idleWorkers.total).toBe(2);
      expect(manager.idleWorkers.items.map((item: Json) => item.displayName)).toEqual([
        'Ali',
        'Berk',
      ]);
      expect(manager.idleWorkers.items[0].lastLogAt).toBe('2026-10-20T21:30:00.000Z');
      expect(manager.idleWorkers.items[0].filter).toEqual({ authorId: wA });

      const supervisor = (await as(sup).get('/dashboard/overview', { day: '2026-10-19' })).body;
      expect(supervisor.idleWorkers.items.map((item: Json) => item.userId)).toEqual([wA]);
      const busy = (await as(sup).get('/dashboard/overview', { day: DAY })).body;
      expect(busy.idleWorkers.total).toBe(0);
    });

    it('defaults to today in the organization zone and refuses workers', async () => {
      const response = await as(admin).get('/dashboard/overview');
      expect(response.status).toBe(200);
      expect(response.body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((await as(wA).get('/dashboard/overview')).status).toBe(403);
      expect((await as(mgr).get('/dashboard/overview', { day: '2026-02-30' })).status).toBe(400);
    });
  });

  describe('GET /directory', () => {
    it('names only what the caller can see, users in the basic shape', async () => {
      const response = await as(sup).get('/directory');
      expect(response.status).toBe(200);
      const body = directorySchema.parse(response.body);
      expect(body.sites.map((site) => site.name)).toEqual(['North']);
      expect(body.users.map((user) => user.id)).not.toContain(wB);
      expect(JSON.stringify(response.body)).not.toContain('@example.test');
      const all = (await as(mgr).get('/directory')).body;
      expect(all.sites.map((site: Json) => site.name)).toEqual(['North', 'South']);
      expect((await as(wA).get('/directory')).status).toBe(403);
    });
  });

  describe('work-log list, map and filters', () => {
    it('filters by search and photos, sorts by status, and counts ready photos', async () => {
      await ctx.prisma.attachment.create({
        data: {
          organizationId: orgId,
          workLogId: logA1,
          uploadedById: wA,
          fileName: 'p.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          storageKey: `t/${randomUUID()}`,
          status: 'ready',
        },
      });
      await ctx.prisma.attachment.create({
        data: {
          organizationId: orgId,
          workLogId: logA2,
          uploadedById: wA,
          fileName: 'p.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          storageKey: `t/${randomUUID()}`,
          status: 'pending',
        },
      });
      const ids = (response: { body: Json }) => (response.body.items as Json[]).map((i) => i.id);
      expect(ids(await as(mgr).get('/work-logs', { search: 'PUMP' }))).toEqual([logA1]);
      expect(ids(await as(mgr).get('/work-logs', { hasPhotos: 'true' }))).toEqual([logA1]);
      expect(ids(await as(mgr).get('/work-logs', { hasPhotos: 'false' })).sort()).toEqual(
        [logA2, logB1].sort(),
      );
      const list = await as(mgr).get('/work-logs', { sort: 'status:asc' });
      expect(list.status).toBe(200);
      const counts = Object.fromEntries(
        (list.body.items as Json[]).map((item) => [item.id, item.attachmentCount]),
      );
      expect(counts).toEqual({ [logA1]: 1, [logA2]: 0, [logB1]: 0 });
      expect((await as(mgr).get(`/work-logs/${logA1}`)).body.attachmentCount).toBe(1);
      expect(ids(await as(sup).get('/work-logs', { search: 'fence' }))).toEqual([]);
    });

    it('maps only located, visible logs and caps them', async () => {
      const range = { occurredFrom: '2026-10-19T00:00:00Z', occurredTo: '2026-10-22T00:00:00Z' };
      const manager = workLogMapSchema.parse((await as(mgr).get('/work-logs/map', range)).body);
      expect(manager.items.map((item) => item.id)).toEqual([logA1, logB1]);
      expect(manager.total).toBe(2);
      expect(manager.items[0]!.excerpt).toBe('Checked the pump');
      const capped = (await as(mgr).get('/work-logs/map', { ...range, limit: 1 })).body;
      expect([capped.items.length, capped.total, capped.truncated]).toEqual([1, 2, true]);
      const supervisor = (await as(sup).get('/work-logs/map', range)).body;
      expect(supervisor.items.map((item: Json) => item.id)).toEqual([logA1]);
      expect((await as(mgr).get('/work-logs/map', { limit: 1001 })).status).toBe(400);
      // Default: the last 7 days, where the fixture's 2026-10-20 logs may or may not fall.
      const defaults = (await as(mgr).get('/work-logs/map')).body;
      expect(Date.parse(defaults.occurredTo) - Date.parse(defaults.occurredFrom)).toBe(7 * DAY_MS);
    });
  });

  describe('task filters', () => {
    it('open and overdue follow the server clock, and keep tasks without a due time', async () => {
      const ids = async (query: Record<string, string>) =>
        ((await as(mgr).get('/tasks', query)).body.items as Json[]).map((i) => i.id).sort();
      expect(await ids({ open: 'true' })).toEqual([tOver, tBlock].sort());
      expect(await ids({ open: 'false' })).toEqual([tDone]);
      expect(await ids({ overdue: 'true' })).toEqual([tOver]);
      expect(await ids({ overdue: 'false' })).toEqual([tBlock, tDone].sort());
      expect(
        ((await as(sup).get('/tasks', { open: 'true' })).body.items as Json[]).map((i) => i.id),
      ).toEqual([tOver]);
    });
  });

  describe('POST /work-logs/bulk-status', () => {
    it('reviews each item on its own, never the caller’s own log, raising versions', async () => {
      const own = (await createWorkLog(ctx.prisma, orgId, sup, { siteId: s1 })).id;
      const response = await as(sup).post('/work-logs/bulk-status', {
        status: 'approved',
        items: [
          { id: logA1, expectedVersion: 1 },
          { id: own },
          { id: logB1 },
          { id: logA2, expectedVersion: 7 },
        ],
      });
      expect(response.status).toBe(200);
      const body = bulkWorkLogStatusResultSchema.parse(response.body);
      expect(body.results.map((r) => [r.id, r.ok ? 200 : r.error.statusCode])).toEqual([
        [logA1, 200],
        [own, 403],
        [logB1, 404],
        [logA2, 409],
      ]);
      expect([body.succeeded, body.failed]).toEqual([1, 3]);
      const approved = body.results[0]!;
      expect(approved.ok && approved.workLog.version).toBe(2);
      expect(approved.ok && approved.workLog.review?.reviewedById).toBe(sup);
      const rows = await ctx.prisma.workLog.findMany({
        where: { id: { in: [own, logB1, logA2] } },
      });
      expect(rows.map((row) => row.status)).toEqual(['submitted', 'submitted', 'submitted']);
      expect(
        await ctx.prisma.auditEvent.count({ where: { action: 'work_log.status_changed' } }),
      ).toBe(1);
      expect(
        await ctx.prisma.outboxEvent.count({ where: { eventType: 'work_log.status_changed' } }),
      ).toBe(1);
    });

    it('requires a note to reject, refuses workers, and caps the batch', async () => {
      expect(
        (
          await as(sup).post('/work-logs/bulk-status', {
            status: 'rejected',
            items: [{ id: logA1 }],
          })
        ).status,
      ).toBe(400);
      const rejected = await as(sup).post('/work-logs/bulk-status', {
        status: 'rejected',
        note: 'Blurry photo',
        items: [{ id: logA1 }],
      });
      expect(rejected.body.results[0].workLog.review.note).toBe('Blurry photo');
      expect(
        (
          await as(wA).post('/work-logs/bulk-status', {
            status: 'approved',
            items: [{ id: logB1 }],
          })
        ).status,
      ).toBe(403);
      const tooMany = Array.from({ length: 101 }, () => ({ id: randomUUID() }));
      expect(
        (await as(mgr).post('/work-logs/bulk-status', { status: 'approved', items: tooMany }))
          .status,
      ).toBe(400);
    });
  });

  describe('histories', () => {
    it('shows a log’s events oldest first, only allowed fields, redacted, 404 when invisible', async () => {
      expect(
        (await as(sup).patch(`/work-logs/${logA1}/status`, { status: 'approved' })).status,
      ).toBe(200);
      // A stored event whose snapshots hold a sensitive key and a field the history hides.
      await ctx.app.get(AuditService).record(ctx.prisma, {
        organizationId: orgId,
        action: 'work_log.updated',
        entityType: 'work_log',
        entityId: logA1,
        before: { text: 'a', apiToken: 'one', version: 1 },
        after: { text: 'b', apiToken: 'two', version: 2 },
      });
      const response = await as(mgr).get(`/work-logs/${logA1}/history`);
      expect(response.status).toBe(200);
      const body = recordHistorySchema.parse(response.body);
      expect(body.items.map((item) => item.action)).toEqual([
        'work_log.status_changed',
        'work_log.updated',
      ]);
      expect(body.items[0]!.actorName).toBe('Selin');
      expect(Object.keys(body.items[0]!.changes ?? {}).sort()).toEqual(['review', 'status']);
      expect(body.items[1]!.changes).toEqual({ text: { from: 'a', to: 'b' } });
      expect(body.items[1]!.actorType).toBe('system');
      for (const item of response.body.items as Json[]) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'action',
            'actorId',
            'actorName',
            'actorType',
            'changes',
            'entityId',
            'entityType',
            'id',
            'occurredAt',
            'offline',
          ].sort(),
        );
      }
      expect(response.text).not.toContain('one');
      expect(response.text).not.toContain('correlation');
      expect((await as(sup).get(`/work-logs/${logB1}/history`)).status).toBe(404);
      expect((await as(wA).get(`/work-logs/${logA1}/history`)).status).toBe(200);
      expect((await as(wB).get(`/work-logs/${logA1}/history`)).status).toBe(404);
    });

    it('shows a task’s events to whoever sees the task, 404 otherwise', async () => {
      expect(
        (await as(mgr).patch(`/tasks/${tOver}/status`, { status: 'in_progress' })).status,
      ).toBe(200);
      const body = (await as(sup).get(`/tasks/${tOver}/history`)).body;
      expect(body.items.map((item: Json) => item.action)).toEqual(['task.status_changed']);
      expect(body.items[0].changes.status).toEqual({ from: 'todo', to: 'in_progress' });
      expect(body.items[0].changes.version).toBeUndefined();
      expect((await as(sup).get(`/tasks/${tBlock}/history`)).status).toBe(404);
      expect((await as(wA).get(`/tasks/${tOver}/history`)).status).toBe(200);
      expect((await as(wB).get(`/tasks/${tOver}/history`)).status).toBe(404);
    });
  });

  describe('CSV exports', () => {
    const lines = (text: string) =>
      text
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n');

    it('exports the supervisor’s scope only, neutralises formulas, and is audited', async () => {
      await createWorkLog(ctx.prisma, orgId, wA, {
        siteId: s1,
        occurredAt: new Date('2026-10-20T08:00:00Z'),
        text: '=HYPERLINK("http://x","click"), ok',
      });
      const response = await as(sup).get('/exports/work-logs.csv', { sort: 'occurredAt:asc' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('content-disposition')).toMatch(
        /^attachment; filename="work-logs-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      const rows = lines(response.text);
      expect(rows[0]).toMatch(/^ID,Occurred at,Time zone,Occurred at \(UTC\),Status,Worker,/);
      expect(rows).toHaveLength(4); // header + three S1 logs, never logB1
      expect(response.text).not.toContain(logB1);
      expect(rows[1]).toContain(`"'=HYPERLINK(""http://x"",""click""), ok"`);
      expect(rows[1]).toContain('2026-10-20 11:00,Europe/Istanbul,2026-10-20T08:00:00.000Z');
      expect(rows[1]).toContain(',Ali,North,');

      const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'export.work_logs' },
      });
      expect(audit).toMatchObject({ entityType: 'export', actorId: sup, organizationId: orgId });
      expect(audit.after).toMatchObject({
        format: 'csv',
        rowCount: 3,
        filters: { sort: 'occurredAt:asc', includeArchived: false },
      });
      expect(
        await ctx.prisma.outboxEvent.count({ where: { eventType: { startsWith: 'export' } } }),
      ).toBe(0);
    });

    it('starts with a UTF-8 byte order mark, and audits an empty export', async () => {
      const password = `${randomUUID()}Aa1!`;
      await ctx.setPassword(mgr, password);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: mgr } });
      const login = await ctx.loginAs(user.email!, password);
      const token = login.body.tokens.accessToken as string;
      const raw = await fetch(`${ctx.url}/exports/tasks.csv?search=nothing-matches`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const bytes = new Uint8Array(await raw.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes);
      expect(lines(text)).toHaveLength(1);
      const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'export.tasks' },
      });
      expect(audit.after).toMatchObject({ rowCount: 0, filters: { search: 'nothing-matches' } });
    });

    it('exports tasks of the scope with names, and refuses workers', async () => {
      const response = await as(sup).get('/exports/tasks.csv');
      const rows = lines(response.text);
      expect(rows).toHaveLength(3); // tOver and tDone at S1
      expect(response.text).not.toContain(tBlock);
      expect(rows.find((row) => row.startsWith(tOver))).toContain(',Ali,');
      expect((await as(wA).get('/exports/tasks.csv')).status).toBe(403);
      expect((await as(wA).get('/exports/work-logs.csv')).status).toBe(403);
    });

    it('refuses more than 10,000 rows with export_too_large', async () => {
      await ctx.prisma.workLog.createMany({
        data: Array.from({ length: 10_001 }, () => ({
          organizationId: orgId,
          authorId: wB,
          clientId: randomUUID(),
          occurredAt: new Date('2026-10-18T10:00:00Z'),
        })),
      });
      const response = await as(mgr).get('/exports/work-logs.csv');
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('export_too_large');
      // A narrower filter works.
      expect((await as(mgr).get('/exports/work-logs.csv', { siteId: s1 })).status).toBe(200);
    });
  });

  describe('GET /reports/work-logs', () => {
    const range = {
      occurredFrom: '2026-10-19T21:00:00.000Z',
      occurredTo: '2026-10-21T21:00:00.000Z',
    };

    it('totals and groups by local day, only inside the caller’s scope', async () => {
      const manager = workLogReportSchema.parse(
        (await as(mgr).get('/reports/work-logs', range)).body,
      );
      expect(manager.totals).toMatchObject({
        logs: 3,
        submitted: 3,
        withLocation: 2,
        withPhotos: 0,
      });
      expect(manager.byDay).toEqual([
        { day: '2026-10-20', count: 2 },
        { day: '2026-10-21', count: 1 },
      ]);
      expect(manager.bySite.map((group) => [group.name, group.count])).toEqual([
        ['North', 2],
        ['South', 1],
      ]);
      const supervisor = (await as(sup).get('/reports/work-logs', range)).body;
      expect(supervisor.totals.logs).toBe(2);
      expect(JSON.stringify(supervisor)).not.toContain(logB1);
      expect(supervisor.byWorker.map((row: Json) => row.displayName)).toEqual(['Ali']);
    });

    it('refuses a range over 92 days and workers', async () => {
      expect(
        (
          await as(mgr).get('/reports/work-logs', {
            occurredFrom: '2026-01-01T00:00:00Z',
            occurredTo: '2026-06-01T00:00:00Z',
          })
        ).status,
      ).toBe(400);
      expect((await as(wA).get('/reports/work-logs', range)).status).toBe(403);
    });
  });

  describe('organization time zone and user locale', () => {
    it('validates the IANA time zone and reports it in the summary', async () => {
      const bad = await as(admin).patch('/organization', { settings: { timeZone: 'Mars/Base' } });
      expect(bad.status).toBe(400);
      const good = await as(admin).patch('/organization', {
        settings: { timeZone: 'Europe/Berlin', workLogEditWindowHours: 24 },
      });
      expect(good.status).toBe(200);
      expect(good.body.settings.timeZone).toBe('Europe/Berlin');
      expect((await as(wA).get('/organization')).body.timeZone).toBe('Europe/Berlin');
    });

    it('stores a locale on create; a user changes only their own; /auth/me carries it', async () => {
      const created = await as(admin).post('/users', {
        displayName: 'Leyla',
        email: 'leyla@example.test',
        locale: 'tr',
      });
      expect(created.status).toBe(201);
      expect(created.body.locale).toBe('tr');
      expect((await as(wA).patch(`/users/${wA}`, { locale: 'ar' })).body.locale).toBe('ar');
      expect((await as(wA).get('/auth/me')).body.user.locale).toBe('ar');
      expect((await as(wA).patch(`/users/${sup}`, { locale: 'ar' })).status).toBe(403);
      expect((await as(wA).patch(`/users/${wB}`, { locale: 'ar' })).status).toBe(404);
      expect((await as(wA).patch(`/users/${wA}`, { locale: 'fr' })).status).toBe(400);
      expect((await as(admin).patch(`/users/${wB}`, { locale: 'tr' })).body.locale).toBe('tr');
      const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'user.updated', entityId: wA },
      });
      expect(audit.changes).toMatchObject({ locale: { from: 'en', to: 'ar' } });
    });
  });

  describe('user sessions (admin)', () => {
    it('lists sessions without tokens or addresses, and revokes them all, audited', async () => {
      const password = `${randomUUID()}Aa1!`;
      await ctx.setPassword(wA, password);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: wA } });
      const login = await ctx.loginAs(user.email!, password);
      const bearer = ctx.bearer(login.body.tokens.accessToken as string);
      expect((await bearer.get('/auth/me')).status).toBe(200);

      const list = await as(admin).get(`/users/${wA}/sessions`);
      expect(list.status).toBe(200);
      expect(list.body.items.length).toBeGreaterThanOrEqual(1);
      for (const session of list.body.items as Json[]) {
        expect(Object.keys(session).sort()).toEqual(
          [
            'client',
            'createdAt',
            'current',
            'deviceName',
            'expiresAt',
            'id',
            'lastUsedAt',
            'userAgent',
          ].sort(),
        );
        expect(session.current).toBe(false);
      }
      expect(list.text).not.toMatch(/token|hash|ipAddress/i);
      expect((await as(sup).get(`/users/${wA}/sessions`)).status).toBe(403);
      expect((await as(sup).post(`/users/${wA}/sessions/revoke`)).status).toBe(403);

      const revoked = await as(admin).post(`/users/${wA}/sessions/revoke`);
      expect(revoked.status).toBe(200);
      expect(revoked.body.revoked).toBe(list.body.items.length);
      expect((await bearer.get('/auth/me')).status).toBe(401);
      const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'auth.session_revoked', entityId: wA },
      });
      expect(audit.after).toMatchObject({ reason: 'admin_revoked' });
      expect((await as(admin).post(`/users/${randomUUID()}/sessions/revoke`)).status).toBe(404);
    });
  });

  describe('notifications in the recipient’s locale', () => {
    it('renders for a Turkish recipient with the English fallback, push generic', async () => {
      await ctx.prisma.user.update({ where: { id: wA }, data: { locale: 'tr' } });
      expect(
        (
          await as(sup).patch(`/work-logs/${logA1}/status`, {
            status: 'rejected',
            note: 'Wrong site photo',
          })
        ).status,
      ).toBe(200);
      const consumer = ctx.app.get(OutboxConsumer);
      consumer.resetState();
      await consumer.processPending();
      const rows = await ctx.prisma.notification.findMany({ where: { recipientId: wA } });
      expect(rows.map((row) => [row.type, row.title, row.body])).toEqual([
        ['work_log.rejected', 'Work log rejected', 'Your work log was rejected: Wrong site photo'],
      ]);
    });
  });
});
