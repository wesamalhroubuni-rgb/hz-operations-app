import { taskListSchema, taskSchema } from '@ops/shared';
import {
  at,
  createMembership,
  createSite,
  createTask,
  createTeam,
  createTenant,
  createUser,
  eventCounts,
  unknownId,
  type Tenant,
} from './support/factories';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

describe('tasks', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let other: Tenant;
  let api: ApiCaller;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    other = await createTenant(ctx.prisma, 'Other Org');
    api = ctx.as(tenant.admin.id);
  });
  afterAll(() => ctx.close());

  const orgId = () => tenant.organization.id;
  const titles = (response: { body: Json }) =>
    (response.body.items as Json[]).map((item) => item.title);
  const detailPaths = (response: { body: Json }) =>
    (response.body.details as Json[]).map((detail) => detail.path).sort();

  describe('create', () => {
    it('creates a task with site, team, due date and assignees (201)', async () => {
      const [site, team, one, two] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);

      const response = await api.post('/tasks', {
        title: '  Replace the gate motor ',
        description: 'North entrance',
        priority: 'high',
        siteId: site.id,
        teamId: team.id,
        assigneeIds: [two.id, one.id],
        dueAt: '2026-11-01T09:00:00+03:00',
      });

      expect(response.status).toBe(201);
      expect(taskSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        organizationId: orgId(),
        title: 'Replace the gate motor',
        description: 'North entrance',
        status: 'todo',
        priority: 'high',
        siteId: site.id,
        teamId: team.id,
        createdById: tenant.admin.id,
        assigneeIds: [one.id, two.id].sort(),
        dueAt: '2026-11-01T06:00:00.000Z',
        completedAt: null,
        archivedAt: null,
      });
      expect((await api.get(`/tasks/${response.body.id}`)).body).toEqual(response.body);
    });

    it('defaults to todo, normal priority, no site, no team, no assignee, no due date', async () => {
      const response = await api.post('/tasks', { title: 'Sweep the yard' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'todo',
        priority: 'normal',
        siteId: null,
        teamId: null,
        assigneeIds: [],
        dueAt: null,
        description: null,
        completedAt: null,
      });
    });

    it('records the acting user as the creator', async () => {
      const someone = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), someone.id, 'manager', { orgWide: true });
      const response = await ctx.as(someone.id).post('/tasks', { title: 'Mine' });
      expect(response.status).toBe(201);
      expect(response.body.createdById).toBe(someone.id);
    });

    it.each([
      ['createdById', '0190f3a2-7c1e-7000-8000-000000000001'],
      ['organizationId', '0190f3a2-7c1e-7000-8000-000000000001'],
      ['completedAt', '2026-09-01T08:00:00Z'],
      ['id', '0190f3a2-7c1e-7000-8000-000000000001'],
    ])('rejects a create body that names %s (400) and stores nothing', async (key, value) => {
      const response = await api.post('/tasks', { title: 'Mine', [key]: value });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('validation_failed');
      expect(response.body.details).toContainEqual({
        path: key,
        message: 'is not a recognised field',
      });
      expect(await ctx.prisma.task.count()).toBe(0);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('sets completedAt when a task is created already done', async () => {
      const response = await api.post('/tasks', { title: 'Already done', status: 'done' });
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('done');
      const gap =
        new Date(response.body.completedAt).getTime() - new Date(response.body.createdAt).getTime();
      expect(Math.abs(gap)).toBeLessThan(5000);
    });

    it.each([
      ['a missing title', {}],
      ['a blank title', { title: '  ' }],
      ['an unknown status', { title: 'T', status: 'started' }],
      ['an unknown priority', { title: 'T', priority: 'critical' }],
      ['a due date without an offset', { title: 'T', dueAt: '2026-11-01T09:00:00' }],
      ['a due date that is only a date', { title: 'T', dueAt: '2026-11-01' }],
      ['assignees that are not a list', { title: 'T', assigneeIds: 'everyone' }],
      ['an assignee that is not a UUID', { title: 'T', assigneeIds: ['bob'] }],
      ['a site that is not a UUID', { title: 'T', siteId: 'north' }],
    ])('rejects %s (400)', async (_name, body) => {
      const response = await api.post('/tasks', body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('validation_failed');
      expect(await ctx.prisma.task.count()).toBe(0);
    });

    it('rejects the same assignee twice (400)', async () => {
      const user = await createUser(ctx.prisma, orgId());
      const response = await api.post('/tasks', { title: 'T', assigneeIds: [user.id, user.id] });
      expect(response.status).toBe(400);
      expect(response.body.details).toEqual([
        { path: 'assigneeIds', message: 'must not contain duplicates' },
      ]);
    });

    it('rejects assignees, site and team of another organization or archived (422)', async () => {
      const [mine, archivedUser, foreignUser, foreignSite, archivedTeam] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId(), { archivedAt: at() }),
        createUser(ctx.prisma, other.organization.id),
        createSite(ctx.prisma, other.organization.id),
        createTeam(ctx.prisma, orgId(), { archivedAt: at() }),
      ]);

      const response = await api.post('/tasks', {
        title: 'T',
        siteId: foreignSite.id,
        teamId: archivedTeam.id,
        assigneeIds: [mine.id, archivedUser.id, foreignUser.id, unknownId()],
      });

      expect(response.status).toBe(422);
      expect(detailPaths(response)).toEqual([
        'assigneeIds.1',
        'assigneeIds.2',
        'assigneeIds.3',
        'siteId',
        'teamId',
      ]);
      expect(await ctx.prisma.task.count()).toBe(0);
      expect(await ctx.prisma.taskAssignee.count()).toBe(0);
    });
  });

  describe('update', () => {
    it('changes the fields that are sent; null clears site, team, description and due date', async () => {
      const [site, team] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        title: 'Old',
        description: 'Text',
        siteId: site.id,
        teamId: team.id,
        dueAt: at(60),
      });

      const renamed = await api.patch(`/tasks/${task.id}`, { title: 'New', priority: 'urgent' });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        title: 'New',
        priority: 'urgent',
        description: 'Text',
        siteId: site.id,
        teamId: team.id,
        dueAt: at(60).toISOString(),
      });

      const cleared = await api.patch(`/tasks/${task.id}`, {
        description: null,
        siteId: null,
        teamId: null,
        dueAt: null,
      });
      expect(cleared.body).toMatchObject({
        title: 'New',
        description: null,
        siteId: null,
        teamId: null,
        dueAt: null,
      });
    });

    it('rejects status or assignees in the general update (400), naming the key, and changes nothing', async () => {
      const user = await createUser(ctx.prisma, orgId());
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, { title: 'Original' });

      const statusOnly = await api.patch(`/tasks/${task.id}`, { status: 'done' });
      const mixed = await api.patch(`/tasks/${task.id}`, { title: 'Renamed', status: 'done' });
      const assignees = await api.patch(`/tasks/${task.id}`, {
        title: 'Renamed',
        assigneeIds: [user.id],
      });

      for (const [response, key] of [
        [statusOnly, 'status'],
        [mixed, 'status'],
        [assignees, 'assigneeIds'],
      ] as const) {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('validation_failed');
        expect(response.body.details).toContainEqual({
          path: key,
          message: 'is not a recognised field',
        });
      }
      // Not even the valid part of a rejected body is applied.
      expect((await api.get(`/tasks/${task.id}`)).body).toMatchObject({
        title: 'Original',
        status: 'todo',
        assigneeIds: [],
        completedAt: null,
      });
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('rejects extra keys in the status and assignee bodies (400)', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      const status = await api.patch(`/tasks/${task.id}/status`, { status: 'done', title: 'x' });
      const assignees = await api.put(`/tasks/${task.id}/assignees`, {
        assigneeIds: [],
        status: 'done',
      });
      expect([status.status, assignees.status]).toEqual([400, 400]);
      expect((await api.get(`/tasks/${task.id}`)).body.status).toBe('todo');
    });

    it('answers 404 for a missing task and 409 for an archived one', async () => {
      const archived = await createTask(ctx.prisma, orgId(), tenant.admin.id, { archivedAt: at() });
      expect((await api.patch(`/tasks/${unknownId()}`, { title: 'x' })).status).toBe(404);
      const refused = await api.patch(`/tasks/${archived.id}`, { title: 'x' });
      expect(refused.status).toBe(409);
      expect(refused.body.message).toBe(`Task ${archived.id} is archived and cannot be changed`);
    });
  });

  describe('status', () => {
    it('sets completedAt on done and emits task.status_changed with from and to', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      const before = Date.now();

      const response = await api.patch(`/tasks/${task.id}/status`, { status: 'done' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('done');
      const completedAt = new Date(response.body.completedAt).getTime();
      expect(completedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(completedAt).toBeLessThanOrEqual(Date.now() + 1000);

      const events = await api.get('/outbox-events', { eventType: 'task.status_changed' });
      expect(events.body.total).toBe(1);
      expect(events.body.items[0]).toMatchObject({
        aggregateType: 'task',
        aggregateId: task.id,
        actorId: tenant.admin.id,
        payload: { from: 'todo', to: 'done', task: response.body },
      });
    });

    it('clears completedAt when a task leaves done', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        status: 'done',
        completedAt: at(30),
      });

      const response = await api.patch(`/tasks/${task.id}/status`, { status: 'in_progress' });

      expect(response.body).toMatchObject({ status: 'in_progress', completedAt: null });
      const events = await api.get('/outbox-events', { eventType: 'task.status_changed' });
      expect(events.body.items[0].payload).toMatchObject({ from: 'done', to: 'in_progress' });
    });

    it.each([
      ['todo', 'in_progress'],
      ['in_progress', 'blocked'],
      ['blocked', 'cancelled'],
      ['cancelled', 'todo'],
    ] as const)('moves %s to %s without touching completedAt', async (from, to) => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, { status: from });
      const response = await api.patch(`/tasks/${task.id}/status`, { status: to });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: to, completedAt: null });
    });

    it('walks a task through its life with one event per real change', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      for (const status of ['in_progress', 'in_progress', 'done', 'done', 'todo', 'done']) {
        expect((await api.patch(`/tasks/${task.id}/status`, { status })).status).toBe(200);
      }
      const events = await api.get('/outbox-events', { eventType: 'task.status_changed' });
      expect(
        (events.body.items as Json[]).map((item) => [item.payload.from, item.payload.to]),
      ).toEqual([
        ['todo', 'in_progress'],
        ['in_progress', 'done'],
        ['done', 'todo'],
        ['todo', 'done'],
      ]);
      expect((await api.get(`/tasks/${task.id}`)).body.completedAt).not.toBeNull();
    });

    it('keeps the first completedAt when done is sent again', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        status: 'done',
        completedAt: at(30),
      });
      const response = await api.patch(`/tasks/${task.id}/status`, { status: 'done' });
      expect(response.body.completedAt).toBe(at(30).toISOString());
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it.each([
      ['an unknown status', { status: 'finished' }],
      ['a status in another case', { status: 'DONE' }],
      ['no status', {}],
      ['a status that is null', { status: null }],
    ])('rejects %s (400)', async (_name, body) => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      const response = await api.patch(`/tasks/${task.id}/status`, body);
      expect(response.status).toBe(400);
      expect((await api.get(`/tasks/${task.id}`)).body.status).toBe('todo');
    });

    it('answers 409 for an archived task and 404 for a missing one', async () => {
      const archived = await createTask(ctx.prisma, orgId(), tenant.admin.id, { archivedAt: at() });
      expect((await api.patch(`/tasks/${archived.id}/status`, { status: 'done' })).status).toBe(
        409,
      );
      expect((await api.patch(`/tasks/${unknownId()}/status`, { status: 'done' })).status).toBe(
        404,
      );
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });
  });

  describe('assignees', () => {
    it('replaces the list and emits task.assignees_changed with who was added and removed', async () => {
      const [one, two, three] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        assigneeIds: [one.id, two.id],
      });

      const response = await api.put(`/tasks/${task.id}/assignees`, {
        assigneeIds: [two.id, three.id],
      });

      expect(response.status).toBe(200);
      expect(response.body.assigneeIds).toEqual([two.id, three.id].sort());
      const events = await api.get('/outbox-events');
      expect(events.body.total).toBe(1);
      expect(events.body.items[0]).toMatchObject({
        eventType: 'task.assignees_changed',
        payload: { added: [three.id], removed: [one.id], task: response.body },
      });
    });

    it('clears the list with an empty one', async () => {
      const one = await createUser(ctx.prisma, orgId());
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        assigneeIds: [one.id],
      });
      const response = await api.put(`/tasks/${task.id}/assignees`, { assigneeIds: [] });
      expect(response.body.assigneeIds).toEqual([]);
      expect(await ctx.prisma.taskAssignee.count()).toBe(0);
    });

    it('rejects new assignees of another organization or archived (422) and keeps the list', async () => {
      const [one, foreign, archived] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, other.organization.id),
        createUser(ctx.prisma, orgId(), { archivedAt: at() }),
      ]);
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        assigneeIds: [one.id],
      });

      const response = await api.put(`/tasks/${task.id}/assignees`, {
        assigneeIds: [one.id, foreign.id, archived.id],
      });

      expect(response.status).toBe(422);
      expect(detailPaths(response)).toEqual(['assigneeIds.1', 'assigneeIds.2']);
      expect((await api.get(`/tasks/${task.id}`)).body.assigneeIds).toEqual([one.id]);
    });

    it('lets an assignee who was archived since stay on the list', async () => {
      const [leaver, joiner] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        assigneeIds: [leaver.id],
      });
      await ctx.prisma.user.update({ where: { id: leaver.id }, data: { archivedAt: at() } });

      const response = await api.put(`/tasks/${task.id}/assignees`, {
        assigneeIds: [leaver.id, joiner.id],
      });

      expect(response.status).toBe(200);
      expect(response.body.assigneeIds).toEqual([leaver.id, joiner.id].sort());
    });

    it('rejects a body without the list, and duplicates (400)', async () => {
      const one = await createUser(ctx.prisma, orgId());
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      expect((await api.put(`/tasks/${task.id}/assignees`, {})).status).toBe(400);
      expect(
        (await api.put(`/tasks/${task.id}/assignees`, { assigneeIds: [one.id, one.id] })).status,
      ).toBe(400);
    });
  });

  describe('list', () => {
    interface Fixture {
      north: string;
      south: string;
      electrical: string;
      ada: string;
      ben: string;
    }

    /** Five tasks spread over sites, teams, statuses, priorities, assignees and due dates. */
    async function seed(): Promise<Fixture> {
      const [north, south, electrical, ada, ben] = await Promise.all([
        createSite(ctx.prisma, orgId(), { name: 'North' }),
        createSite(ctx.prisma, orgId(), { name: 'South' }),
        createTeam(ctx.prisma, orgId(), { name: 'Electrical' }),
        createUser(ctx.prisma, orgId(), { displayName: 'Ada' }),
        createUser(ctx.prisma, orgId(), { displayName: 'Ben' }),
      ]);
      const task = (title: string, minute: number, data: Parameters<typeof createTask>[3]) =>
        createTask(ctx.prisma, orgId(), tenant.admin.id, { title, createdAt: at(minute), ...data });

      await task('T1 gate', 1, {
        status: 'todo',
        priority: 'low',
        siteId: north.id,
        assigneeIds: [ada.id],
        dueAt: new Date('2026-10-10T00:00:00Z'),
      });
      await task('T2 wiring', 2, {
        status: 'in_progress',
        priority: 'urgent',
        siteId: north.id,
        teamId: electrical.id,
        assigneeIds: [ada.id, ben.id],
        dueAt: new Date('2026-10-20T00:00:00Z'),
      });
      await task('T3 paint', 3, {
        status: 'done',
        priority: 'normal',
        siteId: south.id,
        assigneeIds: [ben.id],
        dueAt: new Date('2026-10-30T00:00:00Z'),
        description: 'Blue paint for the GATE house',
      });
      await task('T4 audit', 4, { status: 'todo', priority: 'high', teamId: electrical.id });
      await task('T5 old', 5, { status: 'cancelled', archivedAt: at(10), siteId: north.id });
      // The creator of T6 is somebody else, and another organization has a task too.
      await createTask(ctx.prisma, orgId(), ada.id, { title: 'T6 by Ada', createdAt: at(6) });
      await createTask(ctx.prisma, other.organization.id, other.admin.id, { title: 'Foreign' });
      return {
        north: north.id,
        south: south.id,
        electrical: electrical.id,
        ada: ada.id,
        ben: ben.id,
      };
    }

    it('returns the pagination envelope, newest first by default, without archived tasks', async () => {
      await seed();
      const response = await api.get('/tasks');
      expect(response.status).toBe(200);
      expect(taskListSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({ page: 1, pageSize: 25, total: 5 });
      expect(titles(response)).toEqual([
        'T6 by Ada',
        'T4 audit',
        'T3 paint',
        'T2 wiring',
        'T1 gate',
      ]);
    });

    it('includes archived tasks only when asked', async () => {
      await seed();
      const response = await api.get('/tasks', { includeArchived: true });
      expect(response.body.total).toBe(6);
      expect(titles(response)).toContain('T5 old');
      expect(titles(await api.get('/tasks', { includeArchived: false }))).not.toContain('T5 old');
    });

    it('filters by status', async () => {
      await seed();
      expect(titles(await api.get('/tasks', { status: 'todo' }))).toEqual([
        'T6 by Ada',
        'T4 audit',
        'T1 gate',
      ]);
      expect(titles(await api.get('/tasks', { status: 'done' }))).toEqual(['T3 paint']);
      expect(titles(await api.get('/tasks', { status: 'blocked' }))).toEqual([]);
      expect(titles(await api.get('/tasks', { status: 'cancelled' }))).toEqual([]);
      expect((await api.get('/tasks', { status: 'open' })).status).toBe(400);
    });

    it('filters by site, team, assignee, creator and priority', async () => {
      const f = await seed();
      expect(titles(await api.get('/tasks', { siteId: f.north }))).toEqual([
        'T2 wiring',
        'T1 gate',
      ]);
      expect(titles(await api.get('/tasks', { siteId: f.south }))).toEqual(['T3 paint']);
      expect(titles(await api.get('/tasks', { teamId: f.electrical }))).toEqual([
        'T4 audit',
        'T2 wiring',
      ]);
      expect(titles(await api.get('/tasks', { assigneeId: f.ada }))).toEqual([
        'T2 wiring',
        'T1 gate',
      ]);
      expect(titles(await api.get('/tasks', { assigneeId: f.ben }))).toEqual([
        'T3 paint',
        'T2 wiring',
      ]);
      expect(titles(await api.get('/tasks', { createdById: f.ada }))).toEqual(['T6 by Ada']);
      expect(titles(await api.get('/tasks', { priority: 'urgent' }))).toEqual(['T2 wiring']);
      expect(titles(await api.get('/tasks', { assigneeId: unknownId() }))).toEqual([]);
    });

    it('combines filters with AND', async () => {
      const f = await seed();
      expect(
        titles(
          await api.get('/tasks', { siteId: f.north, teamId: f.electrical, assigneeId: f.ben }),
        ),
      ).toEqual(['T2 wiring']);
      expect(titles(await api.get('/tasks', { siteId: f.south, assigneeId: f.ada }))).toEqual([]);
      expect(titles(await api.get('/tasks', { status: 'todo', siteId: f.north }))).toEqual([
        'T1 gate',
      ]);
    });

    it('filters by due range: dueFrom is inclusive, dueTo is exclusive', async () => {
      await seed();
      const due = (query: Record<string, string>) =>
        api.get('/tasks', { ...query, sort: 'dueAt:asc' });

      expect(titles(await due({ dueFrom: '2026-10-20T00:00:00Z' }))).toEqual([
        'T2 wiring',
        'T3 paint',
      ]);
      expect(titles(await due({ dueFrom: '2026-10-20T00:00:00.001Z' }))).toEqual(['T3 paint']);
      expect(titles(await due({ dueTo: '2026-10-20T00:00:00Z' }))).toEqual(['T1 gate']);
      expect(titles(await due({ dueTo: '2026-10-20T00:00:00.001Z' }))).toEqual([
        'T1 gate',
        'T2 wiring',
      ]);
      expect(
        titles(await due({ dueFrom: '2026-10-10T00:00:00Z', dueTo: '2026-10-30T00:00:00Z' })),
      ).toEqual(['T1 gate', 'T2 wiring']);
      // The same instant written with an offset.
      expect(titles(await due({ dueFrom: '2026-10-20T03:00:00+03:00' }))).toEqual([
        'T2 wiring',
        'T3 paint',
      ]);
      // Tasks without a due date never match a due range.
      expect(titles(await due({ dueFrom: '2000-01-01T00:00:00Z' }))).not.toContain('T4 audit');
      expect((await api.get('/tasks', { dueFrom: '2026-10-20' })).status).toBe(400);
    });

    it('searches title and description, case-insensitively', async () => {
      await seed();
      expect(titles(await api.get('/tasks', { search: 'gate' }))).toEqual(['T3 paint', 'T1 gate']);
      expect(titles(await api.get('/tasks', { search: 'WIRING' }))).toEqual(['T2 wiring']);
      expect(titles(await api.get('/tasks', { search: 'Foreign' }))).toEqual([]);
    });

    it('sorts by the allowed fields in both directions', async () => {
      await seed();
      const sorted = async (sort: string, extra: Record<string, string> = {}) =>
        titles(await api.get('/tasks', { sort, ...extra }));

      expect(await sorted('createdAt:asc')).toEqual([
        'T1 gate',
        'T2 wiring',
        'T3 paint',
        'T4 audit',
        'T6 by Ada',
      ]);
      expect(await sorted('createdAt')).toEqual(await sorted('createdAt:asc'));
      // Enum columns sort in declaration order: low, normal, high, urgent.
      expect(await sorted('priority:desc', { dueFrom: '2000-01-01T00:00:00Z' })).toEqual([
        'T2 wiring',
        'T3 paint',
        'T1 gate',
      ]);
      expect(await sorted('priority:asc', { dueFrom: '2000-01-01T00:00:00Z' })).toEqual([
        'T1 gate',
        'T3 paint',
        'T2 wiring',
      ]);
      expect(await sorted('dueAt:desc', { dueFrom: '2000-01-01T00:00:00Z' })).toEqual([
        'T3 paint',
        'T2 wiring',
        'T1 gate',
      ]);
      // todo, in_progress, blocked, done, cancelled.
      expect(await sorted('status:asc', { dueFrom: '2000-01-01T00:00:00Z' })).toEqual([
        'T1 gate',
        'T2 wiring',
        'T3 paint',
      ]);
    });

    it.each([
      ['title:asc'],
      ['id:asc'],
      ['organizationId'],
      ['createdAt:newest'],
      ['createdAt:asc:x'],
    ])('rejects the sort %p (400)', async (sort) => {
      const response = await api.get('/tasks', { sort });
      expect(response.status).toBe(400);
      expect(detailPaths(response)).toEqual(['sort']);
    });

    it('pages through the tasks; a page past the end is empty with the same total', async () => {
      await seed();
      const page = (number: number) => api.get('/tasks', { page: number, pageSize: 2 });
      const [first, second, third, fourth] = await Promise.all([
        page(1),
        page(2),
        page(3),
        page(4),
      ]);

      expect(titles(first)).toEqual(['T6 by Ada', 'T4 audit']);
      expect(titles(second)).toEqual(['T3 paint', 'T2 wiring']);
      expect(titles(third)).toEqual(['T1 gate']);
      expect(titles(fourth)).toEqual([]);
      for (const [index, response] of [first, second, third, fourth].entries()) {
        expect(response.body).toMatchObject({ page: index + 1, pageSize: 2, total: 5 });
      }
      expect((await api.get('/tasks', { page: 1000000, pageSize: 100 })).body.items).toEqual([]);
    });

    it('counts the filtered set in total, not the page', async () => {
      await seed();
      const response = await api.get('/tasks', { status: 'todo', pageSize: 1 });
      expect(response.body).toMatchObject({ pageSize: 1, total: 3 });
      expect(response.body.items).toHaveLength(1);
    });

    it.each([
      ['page 0', { page: 0 }],
      ['a negative page', { page: -1 }],
      ['a page that is not a number', { page: 'first' }],
      ['a fractional page', { page: 1.5 }],
      ['page size 0', { pageSize: 0 }],
      ['page size 101', { pageSize: 101 }],
      ['a page size that is not a number', { pageSize: 'all' }],
    ])('rejects %s (400)', async (_name, query) => {
      const response = await api.get('/tasks', query);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('validation_failed');
    });

    it('keeps a stable order across pages when the sort value is the same', async () => {
      await Promise.all(
        Array.from({ length: 7 }, (_item, index) =>
          createTask(ctx.prisma, orgId(), tenant.admin.id, {
            title: `Same ${index}`,
            priority: 'normal',
            createdAt: at(0),
          }),
        ),
      );
      const pages = await Promise.all(
        [1, 2, 3, 4].map((page) => api.get('/tasks', { page, pageSize: 2, sort: 'priority:asc' })),
      );
      const seen = pages.flatMap(titles);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });
  });

  describe('archive', () => {
    it('archives a task; it stays readable by id and leaves the default list', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      const archived = await api.post(`/tasks/${task.id}/archive`);
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();
      expect((await api.get(`/tasks/${task.id}`)).status).toBe(200);
      expect((await api.get('/tasks')).body.total).toBe(0);
      expect((await api.put(`/tasks/${task.id}/assignees`, { assigneeIds: [] })).status).toBe(409);
    });
  });
});
