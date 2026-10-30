import { randomUUID } from 'node:crypto';
import { OutboxConsumer } from '../src/platform/outbox/outbox-consumer';
import {
  at,
  createLogType,
  createMembership,
  createSite,
  createTask,
  createTeam,
  createTenant,
  createUser,
  createWorkLog,
} from './support/factories';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

// Phase 6 (ADR-0009), test-writer pass: what dashboard.int-spec.ts and the matrix suite do not
// pin yet.
//
//   Org (Europe/Istanbul)   sites S1 North, S2 South    teams T1 Electrical, T2 Logistics
//   supS  supervisor of S1        supT  supervisor of T1
//   wA    worker at S1            wB    worker at S2
//   wT    worker in T1            wU    worker in T2
//   mgr   manager (org-wide)      admin (org-wide)
//
//   logs on 2026-10-20 10:00Z: lA (wA, S1)  lB (wB, S2)  lT (wT, T1 at S2)  lU (wU, T2)
//   tasks: tA (S1, wA)  tB (S2, wB)  tT (T1, wT)  tU (T2, wU)
//
//   supS sees lA / tA only, supT sees lT / tT only, mgr and admin see everything.

const DAY = '2026-10-20';
const RANGE = { occurredFrom: '2026-10-19T21:00:00.000Z', occurredTo: '2026-10-20T21:00:00.000Z' };

/** A minimal RFC 4180 reader: rows of cells, quotes undone. The BOM, if any, is dropped. */
function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && source[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The rows of a CSV answer as objects keyed by header label. */
function csvRecords(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text);
  return rows.map((cells) => Object.fromEntries(header!.map((label, i) => [label, cells[i]!])));
}

describe('Phase 6 dashboard: scope, tampering, exports, time zones, locales, sessions', () => {
  let ctx: TestApp;
  let orgId: string;
  let s1: string;
  let s2: string;
  let t1: string;
  let t2: string;
  let supS: string;
  let supT: string;
  let wA: string;
  let wB: string;
  let wT: string;
  let wU: string;
  let mgr: string;
  let admin: string;
  let lA: string;
  let lB: string;
  let lT: string;
  let lU: string;
  let tA: string;
  let tB: string;
  let tT: string;
  let tU: string;

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
    t1 = (await createTeam(ctx.prisma, orgId, { name: 'Electrical' })).id;
    t2 = (await createTeam(ctx.prisma, orgId, { name: 'Logistics' })).id;
    const person = async (name: string, role: 'worker' | 'supervisor', scope: object) => {
      const id = (await createUser(ctx.prisma, orgId, { displayName: name })).id;
      await createMembership(ctx.prisma, orgId, id, role, scope);
      return id;
    };
    supS = await person('Selin', 'supervisor', { siteIds: [s1] });
    supT = await person('Tarik', 'supervisor', { teamIds: [t1] });
    wA = await person('Ali', 'worker', { siteIds: [s1] });
    wB = await person('Berk', 'worker', { siteIds: [s2] });
    wT = await person('Tuna', 'worker', { teamIds: [t1] });
    wU = await person('Umut', 'worker', { teamIds: [t2] });
    mgr = (await createUser(ctx.prisma, orgId, { displayName: 'Mert' })).id;
    await createMembership(ctx.prisma, orgId, mgr, 'manager', { orgWide: true });

    const when = new Date('2026-10-20T10:00:00Z');
    const log = async (authorId: string, data: object) =>
      (await createWorkLog(ctx.prisma, orgId, authorId, { occurredAt: when, ...data })).id;
    lA = await log(wA, { siteId: s1, text: 'North pump', latitude: 41, longitude: 29 });
    lB = await log(wB, { siteId: s2, text: 'South pump', latitude: 40, longitude: 29 });
    lT = await log(wT, { siteId: s2, teamId: t1, text: 'Cable pump', latitude: 40, longitude: 28 });
    lU = await log(wU, { teamId: t2, text: 'Truck pump', latitude: 39, longitude: 28 });

    const task = async (data: object, assignee: string) =>
      (await createTask(ctx.prisma, orgId, admin, { assigneeIds: [assignee], ...data })).id;
    tA = await task({ siteId: s1, title: 'North task' }, wA);
    tB = await task({ siteId: s2, title: 'South task' }, wB);
    tT = await task({ teamId: t1, title: 'Cable task' }, wT);
    tU = await task({ teamId: t2, title: 'Truck task' }, wU);
  });

  const as = (userId: string): ApiCaller => ctx.as(userId);
  const ids = (response: { body: Json }) => (response.body.items as Json[]).map((i) => i.id).sort();
  const csvIds = (text: string) =>
    csvRecords(text)
      .map((record) => record.ID!)
      .sort();

  describe('a supervisor cannot widen their scope by changing a parameter or an id', () => {
    // Every filter naming somebody else's place, person or record only narrows the caller's
    // visibility: the answer is empty, never the other scope's rows. (lT is at S2 but in T1, so
    // the team supervisor legitimately sees it with siteId=S2; their foreign site is S1.)
    const foreignFiltersOf = (who: string) => [
      { siteId: who === supS ? s2 : s1 },
      { teamId: t2 },
      { authorId: wB },
      { authorId: wU },
      { authorId: who === supS ? wT : wA },
      { siteId: s2, authorId: wB, includeArchived: 'true' },
    ];

    it.each([
      ['site supervisor', () => supS, () => [lA]],
      ['team supervisor', () => supT, () => [lT]],
    ])('work-log list, map, report and export as a %s', async (_label, who, own) => {
      const caller = as(who());
      const foreignFilters = () => foreignFiltersOf(who());
      expect(ids(await caller.get('/work-logs'))).toEqual(own().sort());
      for (const filter of foreignFilters()) {
        const list = await caller.get('/work-logs', filter);
        expect([list.status, list.body.total]).toEqual([200, 0]);
        const map = await caller.get('/work-logs/map', { ...RANGE, ...filter });
        expect([map.status, map.body.total]).toEqual([200, 0]);
        const report = await caller.get('/reports/work-logs', { ...RANGE, ...filter });
        expect([report.status, report.body.totals.logs, report.body.logs]).toEqual([200, 0, []]);
        const csv = await caller.get('/exports/work-logs.csv', filter);
        expect(csv.status).toBe(200);
        expect(csvIds(csv.text)).toEqual([]);
      }
      // The foreign logs by id: 404 like a missing record, for the record and its history.
      for (const id of [lA, lB, lT, lU].filter((id) => !own().includes(id))) {
        expect((await caller.get(`/work-logs/${id}`)).status).toBe(404);
        expect((await caller.get(`/work-logs/${id}/history`)).status).toBe(404);
      }
      // The audit records the filters asked for, and how little came back.
      const exports = await ctx.prisma.auditEvent.findMany({
        where: { action: 'export.work_logs', actorId: who() },
      });
      expect(exports).toHaveLength(foreignFilters().length);
      expect(exports.map((event) => (event.after as Json).rowCount)).toEqual(
        foreignFilters().map(() => 0),
      );
    });

    it.each([
      ['site supervisor', () => supS, () => [tA]],
      ['team supervisor', () => supT, () => [tT]],
    ])('task list (and so the board), export and records as a %s', async (_label, who, own) => {
      const caller = as(who());
      expect(ids(await caller.get('/tasks'))).toEqual(own().sort());
      const filters = [
        { siteId: s2 },
        { teamId: t2 },
        { assigneeId: wB },
        { assigneeId: wU },
        { status: 'todo', siteId: s2 }, // a board column
        { open: 'true', assigneeId: wB },
      ];
      for (const filter of filters) {
        const list = await caller.get('/tasks', filter);
        expect([list.status, list.body.total]).toEqual([200, 0]);
        expect(csvIds((await caller.get('/exports/tasks.csv', filter)).text)).toEqual([]);
      }
      for (const id of [tA, tB, tT, tU].filter((id) => !own().includes(id))) {
        expect((await caller.get(`/tasks/${id}`)).status).toBe(404);
        expect((await caller.get(`/tasks/${id}/history`)).status).toBe(404);
        expect((await caller.patch(`/tasks/${id}`, { title: 'Hijacked' })).status).toBe(404);
      }
    });

    it('managers and admins get the other site and team with the same parameters', async () => {
      for (const who of [mgr, admin]) {
        const caller = as(who);
        expect(ids(await caller.get('/work-logs', { siteId: s2 }))).toEqual([lB, lT].sort());
        expect(ids(await caller.get('/work-logs', { teamId: t2 }))).toEqual([lU]);
        expect(ids(await caller.get('/tasks', { assigneeId: wB }))).toEqual([tB]);
        expect(csvIds((await caller.get('/exports/work-logs.csv', { siteId: s2 })).text)).toEqual(
          [lB, lT].sort(),
        );
        expect(csvIds((await caller.get('/exports/tasks.csv', { teamId: t2 })).text)).toEqual([tU]);
      }
    });

    it('the overview takes no scope parameter: a foreign siteId is ignored, not obeyed', async () => {
      const plain = await as(supS).get('/dashboard/overview', { day: DAY });
      const tampered = await as(supS).get('/dashboard/overview', {
        day: DAY,
        siteId: s2,
        teamId: t2,
        organizationId: randomUUID(),
      });
      expect(tampered.status).toBe(200);
      expect({ ...tampered.body, generatedAt: null }).toEqual({
        ...plain.body,
        generatedAt: null,
      });
      expect(plain.body.logsToday.count).toBe(1);
      expect(JSON.stringify(tampered.body)).not.toContain(s2);
      expect(JSON.stringify(tampered.body)).not.toContain(t2);
    });

    it('people: other users are 404, user filters on a foreign place are empty, memberships are admin only', async () => {
      const users = await as(supS).get('/users');
      expect(users.status).toBe(200);
      const visible = (users.body.items as Json[]).map((u) => u.id);
      expect(visible).toContain(wA);
      expect(visible).not.toContain(wB);
      expect(visible).not.toContain(wU);
      expect((await as(supS).get('/users', { siteId: s2 })).body.total).toBe(0);
      expect((await as(supT).get('/users', { teamId: t2 })).body.total).toBe(0);
      expect((await as(supS).get(`/users/${wB}`)).status).toBe(404);
      expect((await as(supT).get(`/users/${wU}`)).status).toBe(404);
      for (const who of [supS, supT, mgr]) {
        expect((await as(who).get('/memberships', { userId: wB })).status).toBe(403);
      }
      // A manager views people (all of them), an admin manages memberships.
      expect(
        (await as(mgr).get('/users', { siteId: s2 })).body.items.map((u: Json) => u.id),
      ).toEqual([wB]);
      const memberships = await as(admin).get('/memberships', { userId: wB });
      expect([memberships.status, memberships.body.total]).toEqual([200, 1]);
    });

    it('a body may not reference another scope: 422 on create, 404 on bulk review', async () => {
      const outside = await as(supS).post('/tasks', { title: 'Grab', siteId: s2 });
      expect(outside.status).toBe(422);
      const foreignAssignee = await as(supS).post('/tasks', {
        title: 'Grab',
        siteId: s1,
        assigneeIds: [wB],
      });
      expect(foreignAssignee.status).toBe(422);
      expect(await ctx.prisma.task.count({ where: { title: 'Grab' } })).toBe(0);
      const bulk = await as(supT).post('/work-logs/bulk-status', {
        status: 'approved',
        items: [{ id: lA }, { id: lU }, { id: lT }],
      });
      expect(bulk.body.results.map((r: Json) => (r.ok ? 200 : r.error.statusCode))).toEqual([
        404, 404, 200,
      ]);
      const rows = await ctx.prisma.workLog.findMany({ where: { id: { in: [lA, lU] } } });
      expect(rows.map((row) => row.status)).toEqual(['submitted', 'submitted']);
    });

    it('the audit log is admin only', async () => {
      for (const who of [supS, supT, mgr, wA]) {
        expect((await as(who).get('/audit-events')).status).toBe(403);
      }
      const list = await as(admin).get('/audit-events');
      expect(list.status).toBe(200);
    });
  });

  describe('every number equals the list it links to, for each role', () => {
    it.each([
      ['site supervisor', () => supS],
      ['team supervisor', () => supT],
      ['manager', () => mgr],
      ['admin', () => admin],
    ])('as a %s: overview counts, place rows and idle links match list totals', async (_l, who) => {
      const caller = as(who());
      const overview = (await caller.get('/dashboard/overview', { day: DAY })).body;
      const total = async (path: string, filter: Json) =>
        (await caller.get(path, filter)).body.total as number;
      expect(await total('/work-logs', overview.logsToday.filter)).toBe(overview.logsToday.count);
      expect(await total('/work-logs', overview.logsAwaitingApproval.filter)).toBe(
        overview.logsAwaitingApproval.count,
      );
      for (const key of ['tasksOpen', 'tasksOverdue', 'tasksBlocked']) {
        expect(await total('/tasks', overview[key].filter)).toBe(overview[key].count);
      }
      for (const row of [...overview.bySite, ...overview.byTeam] as Json[]) {
        if (row.id !== null) {
          expect(await total('/work-logs', row.logsFilter)).toBe(row.logsToday);
          expect(await total('/tasks', row.tasksFilter)).toBe(row.tasksOpen);
        }
      }
      for (const idle of overview.idleWorkers.items as Json[]) {
        expect(await total('/work-logs', { ...idle.filter, ...overview.logsToday.filter })).toBe(0);
      }
    });

    it.each([
      ['site supervisor', () => supS],
      ['manager', () => mgr],
    ])(
      'as a %s: export rows and report totals equal the list total, per filter',
      async (_l, who) => {
        await ctx.prisma.workLog.update({ where: { id: lA }, data: { status: 'approved' } });
        await ctx.prisma.workLog.update({ where: { id: lB }, data: { status: 'approved' } });
        await createWorkLog(ctx.prisma, orgId, wA, {
          siteId: s1,
          occurredAt: new Date('2026-10-18T09:00:00Z'),
          text: 'Older pump',
        });
        await ctx.prisma.attachment.create({
          data: {
            organizationId: orgId,
            workLogId: lB,
            uploadedById: wB,
            fileName: 'p.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 10,
            storageKey: `t/${randomUUID()}`,
            status: 'ready',
          },
        });
        const caller = as(who());
        const filters: Array<Record<string, string>> = [
          {},
          { status: 'approved' },
          { status: 'submitted' },
          { search: 'PUMP' },
          { search: 'older' },
          { hasPhotos: 'true' },
          { hasPhotos: 'false' },
          { ...RANGE },
          { ...RANGE, status: 'approved', siteId: s1 },
          { authorId: wA, sort: 'occurredAt:asc' },
        ];
        for (const filter of filters) {
          const list = await caller.get('/work-logs', { ...filter, pageSize: 100 });
          const csv = await caller.get('/exports/work-logs.csv', filter);
          expect([filter, csvIds(csv.text)]).toEqual([filter, ids(list)]);
          if (filter.occurredFrom) {
            const report = await caller.get('/reports/work-logs', filter);
            expect(report.body.totals.logs).toBe(list.body.total);
          }
        }
        // The export keeps the list's sort order.
        const ordered = await caller.get('/exports/work-logs.csv', {
          authorId: wA,
          sort: 'occurredAt:asc',
        });
        const listed = await caller.get('/work-logs', { authorId: wA, sort: 'occurredAt:asc' });
        expect(csvRecords(ordered.text).map((record) => record.ID)).toEqual(
          (listed.body.items as Json[]).map((item) => item.id),
        );
        // Each export is one audit event carrying exactly its filters and row count.
        const audits = await ctx.prisma.auditEvent.findMany({
          where: { action: 'export.work_logs', actorId: who() },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        });
        expect(audits).toHaveLength(filters.length + 1);
        const approvedAtS1 = audits[8]!.after as Json;
        expect(approvedAtS1.filters).toMatchObject({
          status: 'approved',
          siteId: s1,
          occurredFrom: RANGE.occurredFrom,
          occurredTo: RANGE.occurredTo,
        });
      },
    );

    it('task exports equal the task list per filter, and are audited', async () => {
      await ctx.prisma.task.update({ where: { id: tB }, data: { status: 'done' } });
      await ctx.prisma.task.update({
        where: { id: tT },
        data: { dueAt: new Date(Date.now() - 86_400_000) },
      });
      for (const who of [supT, mgr]) {
        const caller = as(who);
        for (const filter of [
          {},
          { open: 'true' },
          { open: 'false' },
          { overdue: 'true' },
          { status: 'done' },
          { search: 'cable' },
          { assigneeId: wT },
        ]) {
          const list = await caller.get('/tasks', { ...filter, pageSize: 100 });
          const csv = await caller.get('/exports/tasks.csv', filter);
          expect([filter, csvIds(csv.text)]).toEqual([filter, ids(list)]);
        }
      }
      expect(await ctx.prisma.auditEvent.count({ where: { action: 'export.tasks' } })).toBe(14);
    });

    it('a refused export (worker, bad filter) writes no audit event', async () => {
      expect((await as(wA).get('/exports/work-logs.csv')).status).toBe(403);
      expect((await as(wA).get('/exports/tasks.csv')).status).toBe(403);
      expect((await as(mgr).get('/exports/work-logs.csv', { status: 'nope' })).status).toBe(400);
      expect((await as(mgr).get('/exports/tasks.csv', { sort: 'title:asc' })).status).toBe(400);
      expect(
        await ctx.prisma.auditEvent.count({ where: { action: { startsWith: 'export.' } } }),
      ).toBe(0);
    });
  });

  describe('no self-approval', () => {
    it.each([
      ['supervisor', () => supS, () => s1],
      ['manager', () => mgr, () => s1],
      ['admin', () => admin, () => s2],
    ])('a %s can review others but never their own log, single or bulk', async (_l, who, site) => {
      const own = (await createWorkLog(ctx.prisma, orgId, who(), { siteId: site() })).id;
      const single = await as(who()).patch(`/work-logs/${own}/status`, { status: 'approved' });
      expect(single.status).toBe(403);
      const rejectOwn = await as(who()).patch(`/work-logs/${own}/status`, {
        status: 'rejected',
        note: 'Self',
      });
      expect(rejectOwn.status).toBe(403);
      for (const status of ['approved', 'rejected']) {
        const bulk = await as(who()).post('/work-logs/bulk-status', {
          status,
          note: 'Batch',
          items: [{ id: own }],
        });
        expect(bulk.status).toBe(200);
        expect(bulk.body.results[0]).toMatchObject({ ok: false, error: { statusCode: 403 } });
      }
      expect((await ctx.prisma.workLog.findUniqueOrThrow({ where: { id: own } })).status).toBe(
        'submitted',
      );
      // Allowed: the same caller on a log by somebody else in their scope.
      const other = who() === admin ? lB : lA;
      expect(
        (await as(who()).patch(`/work-logs/${other}/status`, { status: 'approved' })).status,
      ).toBe(200);
    });

    it('a reviewer who also writes logs still cannot approve them in a mixed bulk', async () => {
      const own = (await createWorkLog(ctx.prisma, orgId, supS, { siteId: s1 })).id;
      const response = await as(supS).post('/work-logs/bulk-status', {
        status: 'approved',
        items: [{ id: own }, { id: lA }],
      });
      expect(response.body.results.map((r: Json) => [r.id, r.ok])).toEqual([
        [own, false],
        [lA, true],
      ]);
      expect(response.body.results[0].error.code).toBe('forbidden');
      expect(
        await ctx.prisma.auditEvent.count({
          where: { action: 'work_log.status_changed', entityId: own },
        }),
      ).toBe(0);
    });
  });

  describe('CSV escaping over HTTP', () => {
    const NASTY = [
      '=1+1',
      '+SUM(A1)',
      '-2+3',
      '@cmd',
      '\tTabbed',
      '\rReturn first',
      'He said "hi", then left',
      'Line one\nLine two\r\nLine three',
      'Ayşe çalıştı – ğüşöç İı',
      'عامل في الموقع',
      'Emoji 👷‍♀️ ok',
      '\uFEFFinner BOM',
      ' =leading space',
    ];

    it('writes every hostile log text as one inert cell that reads back as the original', async () => {
      const created: Record<string, string> = {};
      for (const [i, text] of NASTY.entries()) {
        created[
          (
            await createWorkLog(ctx.prisma, orgId, wA, {
              siteId: s1,
              occurredAt: new Date(Date.UTC(2026, 9, 21, 8, i)),
              text,
            })
          ).id
        ] = text;
      }
      const response = await as(mgr).get('/exports/work-logs.csv', { authorId: wA });
      expect(response.status).toBe(200);
      const records = csvRecords(response.text);
      expect(records).toHaveLength(NASTY.length + 1); // plus lA
      for (const record of records) {
        expect(Object.keys(record)).toHaveLength(21);
        const original = created[record.ID!];
        if (original === undefined) {
          continue;
        }
        const formula = /^[=+\-@\t\r]/.test(original);
        expect([original, record.Text]).toEqual([original, formula ? `'${original}` : original]);
        // Nothing a spreadsheet would run.
        expect(record.Text).not.toMatch(/^[=+\-@\t\r]/);
      }
    });

    it('neutralises names and titles too (worker, site, task, note) and keeps numbers numeric', async () => {
      await ctx.prisma.user.update({ where: { id: wA }, data: { displayName: '=HYPERLINK("x")' } });
      await ctx.prisma.site.update({ where: { id: s1 }, data: { name: '@North, "Main"' } });
      await ctx.prisma.task.update({ where: { id: tA }, data: { title: '-Drop table' } });
      await ctx.prisma.workLog.update({
        where: { id: lA },
        data: {
          taskId: tA,
          latitude: -33.5,
          longitude: -70.25,
          customFields: { note: '=cmd|calc' },
          status: 'rejected',
          reviewNote: '+bad',
          reviewedById: admin,
          reviewedAt: new Date('2026-10-20T12:00:00Z'),
        },
      });
      const [record] = csvRecords(
        (await as(mgr).get('/exports/work-logs.csv', { siteId: s1 })).text,
      );
      expect(record).toMatchObject({
        Worker: `'=HYPERLINK("x")`,
        Site: `'@North, "Main"`,
        Task: `'-Drop table`,
        'Review note': `'+bad`,
        Latitude: '-33.5',
        Longitude: '-70.25',
        'Custom fields': '{"note":"=cmd|calc"}',
      });
      const [task] = csvRecords((await as(mgr).get('/exports/tasks.csv', { siteId: s1 })).text);
      expect(task).toMatchObject({ Title: `'-Drop table`, Assignees: `'=HYPERLINK("x")` });
    });

    it('sends the BOM bytes and CRLF line ends on the wire', async () => {
      const password = `${randomUUID()}Aa1!`;
      await ctx.setPassword(mgr, password);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: mgr } });
      const login = await ctx.loginAs(user.email!, password);
      const raw = await fetch(`${ctx.url}/exports/work-logs.csv`, {
        headers: { Authorization: `Bearer ${login.body.tokens.accessToken as string}` },
      });
      const bytes = new Uint8Array(await raw.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      // The fixture texts hold no line breaks, so every LF is part of a CRLF line end.
      expect(/(?<!\r)\n/.test(text)).toBe(false);
      expect(text.split('\r\n').length).toBe(6); // header, four logs, the empty end
      expect(text.endsWith('\r\n')).toBe(true);
    });
  });

  describe('time zone and day boundaries', () => {
    it('defaults "today" to the organization day, not the UTC day', async () => {
      ctx.clock.freeze(new Date('2026-10-20T21:30:00Z')); // 00:30 on the 21st in Istanbul
      await createWorkLog(ctx.prisma, orgId, wA, {
        siteId: s1,
        occurredAt: new Date('2026-10-20T21:10:00Z'),
      });
      const istanbul = (await as(mgr).get('/dashboard/overview')).body;
      expect(istanbul).toMatchObject({
        day: '2026-10-21',
        dayStart: '2026-10-20T21:00:00.000Z',
        dayEnd: '2026-10-21T21:00:00.000Z',
      });
      expect(istanbul.logsToday.count).toBe(1);

      await ctx.prisma.organization.update({
        where: { id: orgId },
        data: { settings: { timeZone: 'UTC' } },
      });
      const utc = (await as(mgr).get('/dashboard/overview')).body;
      expect(utc.day).toBe('2026-10-20');
      expect(utc.logsToday.count).toBe(5); // the four fixture logs plus the 21:10Z one
    });

    it('falls back to Europe/Istanbul for a stored zone that is not valid', async () => {
      await ctx.prisma.organization.update({
        where: { id: orgId },
        data: { settings: { timeZone: 'Mars/Base' } },
      });
      const body = (await as(mgr).get('/dashboard/overview', { day: DAY })).body;
      expect(body.timeZone).toBe('Europe/Istanbul');
      expect((await as(mgr).get('/organization')).body.timeZone).toBe('Europe/Istanbul');
    });

    it('counts the 25-hour Berlin fall-back day and writes local times in exports', async () => {
      await ctx.prisma.organization.update({
        where: { id: orgId },
        data: { settings: { timeZone: 'Europe/Berlin' } },
      });
      const instants = [
        '2026-10-24T21:59:00Z', // 23:59 CEST on the 24th
        '2026-10-24T22:00:00Z', // 00:00 CEST on the 25th
        '2026-10-25T00:30:00Z', // 02:30 CEST (first 02:30)
        '2026-10-25T01:30:00Z', // 02:30 CET (second 02:30)
        '2026-10-25T22:59:00Z', // 23:59 CET on the 25th
        '2026-10-25T23:00:00Z', // 00:00 CET on the 26th
      ];
      const made: string[] = [];
      for (const occurredAt of instants) {
        made.push(
          (
            await createWorkLog(ctx.prisma, orgId, wB, {
              siteId: s2,
              occurredAt: new Date(occurredAt),
            })
          ).id,
        );
      }
      const overview = (await as(mgr).get('/dashboard/overview', { day: '2026-10-25' })).body;
      expect(overview).toMatchObject({
        dayStart: '2026-10-24T22:00:00.000Z',
        dayEnd: '2026-10-25T23:00:00.000Z',
      });
      expect(overview.logsToday.count).toBe(4);
      const report = (
        await as(mgr).get('/reports/work-logs', {
          occurredFrom: '2026-10-23T22:00:00.000Z',
          occurredTo: '2026-10-26T23:00:00.000Z',
          authorId: wB,
        })
      ).body;
      expect(report.byDay).toEqual([
        { day: '2026-10-24', count: 1 },
        { day: '2026-10-25', count: 4 },
        { day: '2026-10-26', count: 1 },
      ]);
      const records = csvRecords(
        (
          await as(mgr).get('/exports/work-logs.csv', {
            authorId: wB,
            occurredFrom: '2026-10-24T00:00:00Z',
            sort: 'occurredAt:asc',
          })
        ).text,
      );
      expect(
        records.map((r) => [r['Occurred at'], r['Time zone'], r['Occurred at (UTC)']]),
      ).toEqual([
        ['2026-10-24 23:59', 'Europe/Berlin', '2026-10-24T21:59:00.000Z'],
        ['2026-10-25 00:00', 'Europe/Berlin', '2026-10-24T22:00:00.000Z'],
        ['2026-10-25 02:30', 'Europe/Berlin', '2026-10-25T00:30:00.000Z'],
        ['2026-10-25 02:30', 'Europe/Berlin', '2026-10-25T01:30:00.000Z'],
        ['2026-10-25 23:59', 'Europe/Berlin', '2026-10-25T22:59:00.000Z'],
        ['2026-10-26 00:00', 'Europe/Berlin', '2026-10-25T23:00:00.000Z'],
      ]);
      expect(records.map((r) => r.ID)).toEqual(made);
    });

    it('counts the 23-hour New York spring-forward day', async () => {
      await ctx.prisma.organization.update({
        where: { id: orgId },
        data: { settings: { timeZone: 'America/New_York' } },
      });
      await createWorkLog(ctx.prisma, orgId, wB, {
        siteId: s2,
        occurredAt: new Date('2026-03-09T03:59:00Z'), // 23:59 EDT on the 8th
      });
      await createWorkLog(ctx.prisma, orgId, wB, {
        siteId: s2,
        occurredAt: new Date('2026-03-09T04:00:00Z'), // 00:00 EDT on the 9th
      });
      const overview = (await as(mgr).get('/dashboard/overview', { day: '2026-03-08' })).body;
      expect(overview).toMatchObject({
        dayStart: '2026-03-08T05:00:00.000Z',
        dayEnd: '2026-03-09T04:00:00.000Z',
      });
      expect(overview.logsToday.count).toBe(1);
    });
  });

  describe('log-type editor versioning end to end', () => {
    it('a saved key renamed through the API is a removed field plus a new one: old logs keep theirs', async () => {
      // The API does not refuse a changed key: it cannot tell a rename from "remove a field, add
      // another", both legal (ADR-0003, ADR-0009). The web editor never edits a saved key.
      const logType = await createLogType(ctx.prisma, orgId, {
        fields: [
          { key: 'area', label: 'Area', type: 'text', required: true },
          { key: 'count', label: 'Count', type: 'number' },
        ],
      });
      const old = (
        await createWorkLog(ctx.prisma, orgId, wA, {
          siteId: s1,
          logTypeId: logType.id,
          logTypeVersion: 1,
          customFields: { area: 'Roof', count: 2 },
        })
      ).id;
      const renamed = await as(mgr).patch(`/log-types/${logType.id}`, {
        fields: [
          { key: 'zone', label: 'Area', type: 'text', required: true },
          { key: 'count', label: 'Count', type: 'number' },
        ],
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.version).toBe(2);
      expect(renamed.body.fields.map((f: Json) => f.key)).toEqual(['zone', 'count']);

      // The old log: its values and its version, untouched; still readable and editable.
      const read = (await as(mgr).get(`/work-logs/${old}`)).body;
      expect(read).toMatchObject({ logTypeVersion: 1, customFields: { area: 'Roof', count: 2 } });
      const textEdit = await as(wA).patch(`/work-logs/${old}`, { text: 'Typo fixed' });
      expect(textEdit.status).toBe(200);
      expect(textEdit.body).toMatchObject({
        logTypeVersion: 1,
        customFields: { area: 'Roof', count: 2 },
      });

      // A new log is checked against version 2: the old key is unknown, the new one required.
      const write = (customFields: Json) =>
        as(wA).post('/work-logs', {
          clientId: randomUUID(),
          occurredAt: at().toISOString(),
          siteId: s1,
          logTypeId: logType.id,
          customFields,
        });
      expect((await write({ area: 'Roof' })).status).toBe(400);
      const fresh = await write({ zone: 'Roof' });
      expect(fresh.status).toBe(201);
      expect(fresh.body.logTypeVersion).toBe(2);

      // The audit keeps the old definition (the only place old definitions live).
      const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'log_type.updated', entityId: logType.id },
      });
      expect((audit.before as Json).fields.map((f: Json) => f.key)).toEqual(['area', 'count']);
    });

    it('supervisors may not edit log types; a no-change save keeps the version', async () => {
      const logType = await createLogType(ctx.prisma, orgId);
      const fields = (await as(mgr).get(`/log-types/${logType.id}`)).body.fields;
      expect((await as(supS).patch(`/log-types/${logType.id}`, { fields: [] })).status).toBe(403);
      const same = await as(admin).patch(`/log-types/${logType.id}`, { name: 'Renamed', fields });
      expect(same.body.version).toBe(1);
    });
  });

  describe('locales: own only, admins for anyone, notifications per recipient', () => {
    it('managers and supervisors may change only their own locale', async () => {
      expect((await as(mgr).patch(`/users/${mgr}`, { locale: 'tr' })).body.locale).toBe('tr');
      expect((await as(supS).patch(`/users/${supS}`, { locale: 'ar' })).body.locale).toBe('ar');
      expect((await as(mgr).patch(`/users/${wA}`, { locale: 'tr' })).status).toBe(403);
      expect((await as(supS).patch(`/users/${wA}`, { locale: 'tr' })).status).toBe(403);
      expect((await as(supS).patch(`/users/${wB}`, { locale: 'tr' })).status).toBe(404);
      expect(
        (await as(wA).patch(`/users/${wA}`, { locale: 'tr', email: 'x@example.test' })).status,
      ).toBe(403);
      const rows = await ctx.prisma.user.findMany({ where: { id: { in: [wA, wB] } } });
      expect(rows.map((row) => row.locale)).toEqual(['en', 'en']);
      expect((await as(admin).patch(`/users/${wA}`, { locale: 'ar' })).body.locale).toBe('ar');
    });

    it('a stored locale that is not supported reads as English', async () => {
      await ctx.prisma.user.update({ where: { id: wA }, data: { locale: 'fr' } });
      expect((await as(admin).get(`/users/${wA}`)).body.locale).toBe('en');
      expect((await as(wA).get('/auth/me')).body.user.locale).toBe('en');
    });

    it('renders one notification per assignee in their locale (English fallback), once', async () => {
      await ctx.prisma.user.update({ where: { id: wA }, data: { locale: 'tr' } });
      await ctx.prisma.user.update({ where: { id: wB }, data: { locale: 'ar' } });
      await ctx.prisma.user.update({ where: { id: wT }, data: { locale: 'xx' } });
      const created = await as(admin).post('/tasks', {
        title: 'Check the valve',
        assigneeIds: [wA, wB, wT, wU],
      });
      expect(created.status).toBe(201);
      const consumer = ctx.app.get(OutboxConsumer);
      consumer.resetState();
      await consumer.processPending();
      consumer.resetState();
      await consumer.processPending(); // a second pass must not duplicate anything
      const rows = await ctx.prisma.notification.findMany({
        where: { type: 'task.assigned' },
        orderBy: { recipientId: 'asc' },
      });
      expect(rows.map((row) => row.recipientId).sort()).toEqual([wA, wB, wT, wU].sort());
      for (const row of rows) {
        expect([row.title, row.body]).toEqual([
          'New task: Check the valve',
          'You have been assigned a task. Open it to see the details.',
        ]);
      }
    });
  });

  describe('sessions are admin only and never leak secrets', () => {
    it('managers, supervisors and workers may neither list nor revoke, not even their own', async () => {
      for (const who of [mgr, supS, wA]) {
        expect((await as(who).get(`/users/${wA}/sessions`)).status).toBe(403);
        expect((await as(who).post(`/users/${wA}/sessions/revoke`)).status).toBe(403);
        expect((await as(who).get(`/users/${who}/sessions`)).status).toBe(403);
      }
    });

    it('an admin cannot reach a user of another organization, and revoking ends only that user', async () => {
      const other = await createTenant(ctx.prisma);
      const stranger = (await createUser(ctx.prisma, other.organization.id)).id;
      await as(stranger).get('/auth/me');
      expect((await as(admin).get(`/users/${stranger}/sessions`)).status).toBe(404);
      expect((await as(admin).post(`/users/${stranger}/sessions/revoke`)).status).toBe(404);

      // Real sign-ins (the harness's `as()` would reopen an ended session).
      const signIn = async (userId: string) => {
        const password = `${randomUUID()}Aa1!`;
        await ctx.setPassword(userId, password);
        const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        // Two organizations exist now, so the sign-in names one.
        const { slug } = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
        const login = await ctx.loginAs(user.email!, password, { organizationSlug: slug });
        expect(login.status).toBe(200);
        return ctx.bearer(login.body.tokens.accessToken as string);
      };
      const workerCaller = await signIn(wA);
      const managerCaller = await signIn(mgr);
      expect((await workerCaller.get('/auth/me')).status).toBe(200);
      const revoked = await as(admin).post(`/users/${wA}/sessions/revoke`);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toEqual({ revoked: 1 });
      expect((await workerCaller.get('/auth/me')).status).toBe(401);
      expect((await managerCaller.get('/auth/me')).status).toBe(200);
      expect((await as(stranger).get('/auth/me')).status).toBe(200);
      const list = await as(admin).get(`/users/${wA}/sessions`);
      expect(list.body.items).toEqual([]);
      // A second revoke has nothing left to end.
      expect((await as(admin).post(`/users/${wA}/sessions/revoke`)).body).toEqual({ revoked: 0 });
    });
  });
});
