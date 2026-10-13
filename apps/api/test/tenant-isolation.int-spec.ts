import { randomUUID } from 'node:crypto';
import { at, createTenant, eventCounts, type Tenant } from './support/factories';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

// Two organizations on one database. Every record carries organizationId; a caller must never
// read, list or change a record of another organization, and must not be able to tell whether
// it exists (404, exactly as for an id that names nothing).

interface World {
  tenant: Tenant;
  api: ApiCaller;
  user: Json;
  site: Json;
  team: Json;
  logType: Json;
  membership: Json;
  task: Json;
  workLog: Json;
  attachment: Json;
  auditEventId: string;
  outboxEventId: string;
}

describe('tenant isolation', () => {
  let ctx: TestApp;
  let a: World;
  let b: World;

  /** Builds one organization with one record of every kind, through the API (so events exist). */
  async function buildWorld(name: string): Promise<World> {
    const tenant = await createTenant(ctx.prisma, name);
    const api = ctx.as(tenant.admin.id);
    const ok = async (response: Promise<{ status: number; body: Json }>) => {
      const result = await response;
      expect(result.status).toBe(201);
      return result.body;
    };

    const user = await ok(
      api.post('/users', { email: 'worker@example.test', displayName: `${name} Worker` }),
    );
    const site = await ok(api.post('/sites', { name: `${name} Site`, code: 'S-01' }));
    const team = await ok(api.post('/teams', { name: `${name} Team` }));
    const logType = await ok(
      api.post('/log-types', {
        key: 'inspection',
        name: `${name} Inspection`,
        fields: [{ key: 'area', label: 'Area', type: 'text' }],
      }),
    );
    const membership = await ok(
      api.post('/memberships', {
        userId: user.id,
        role: 'worker',
        siteIds: [site.id],
        teamIds: [team.id],
      }),
    );
    const task = await ok(
      api.post('/tasks', {
        title: `${name} Task`,
        siteId: site.id,
        teamId: team.id,
        assigneeIds: [user.id],
      }),
    );
    const workLog = await ok(
      api.post('/work-logs', {
        clientId: randomUUID(),
        occurredAt: at().toISOString(),
        text: `${name} log`,
        siteId: site.id,
        teamId: team.id,
        taskId: task.id,
        logTypeId: logType.id,
        customFields: { area: 'Roof' },
      }),
    );
    const attachment = await ok(
      api.post(`/work-logs/${workLog.id}/attachments`, {
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        storageKey: `${tenant.organization.id}/photo.jpg`,
      }),
    );
    const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
      where: { organizationId: tenant.organization.id, entityId: site.id },
    });
    const outbox = await ctx.prisma.outboxEvent.findFirstOrThrow({
      where: { organizationId: tenant.organization.id, aggregateId: site.id },
    });
    return {
      tenant,
      api,
      user,
      site,
      team,
      logType,
      membership,
      task,
      workLog,
      attachment,
      auditEventId: audit.id,
      outboxEventId: outbox.id,
    };
  }

  beforeAll(async () => {
    ctx = await startTestApp();
    await ctx.reset();
    // Read-mostly suite: the two worlds are built once. Tests that write restore nothing because
    // every write they attempt must be refused.
    a = await buildWorld('Alpha');
    b = await buildWorld('Beta');
  });
  afterAll(() => ctx.close());

  /** A snapshot of everything stored for organization B, to prove nothing changed. */
  async function snapshotOfB() {
    const organizationId = b.tenant.organization.id;
    const where = { organizationId };
    return {
      organization: await ctx.prisma.organization.findUnique({ where: { id: organizationId } }),
      users: await ctx.prisma.user.findMany({ where, orderBy: { id: 'asc' } }),
      sites: await ctx.prisma.site.findMany({ where, orderBy: { id: 'asc' } }),
      teams: await ctx.prisma.team.findMany({ where, orderBy: { id: 'asc' } }),
      logTypes: await ctx.prisma.logType.findMany({ where, orderBy: { id: 'asc' } }),
      memberships: await ctx.prisma.membership.findMany({
        where,
        include: { sites: true, teams: true },
        orderBy: { id: 'asc' },
      }),
      tasks: await ctx.prisma.task.findMany({
        where,
        include: { assignees: true },
        orderBy: { id: 'asc' },
      }),
      workLogs: await ctx.prisma.workLog.findMany({ where, orderBy: { id: 'asc' } }),
      attachments: await ctx.prisma.attachment.findMany({ where, orderBy: { id: 'asc' } }),
      events: await eventCounts(ctx.prisma, organizationId),
    };
  }

  const RESOURCES: Array<[string, (world: World) => string]> = [
    ['users', (world) => world.user.id],
    ['sites', (world) => world.site.id],
    ['teams', (world) => world.team.id],
    ['log-types', (world) => world.logType.id],
    ['memberships', (world) => world.membership.id],
    ['tasks', (world) => world.task.id],
    ['work-logs', (world) => world.workLog.id],
    ['attachments', (world) => world.attachment.id],
    ['audit-events', (world) => world.auditEventId],
    ['outbox-events', (world) => world.outboxEventId],
  ];

  describe('reading one record', () => {
    it.each(RESOURCES)('GET /%s/:id of the other organization is 404', async (path, idOf) => {
      // Sanity: each organization can read its own record.
      expect((await a.api.get(`/${path}/${idOf(a)}`)).status).toBe(200);
      expect((await b.api.get(`/${path}/${idOf(b)}`)).status).toBe(200);

      const response = await a.api.get(`/${path}/${idOf(b)}`);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('not_found');
      expect(JSON.stringify(response.body)).not.toContain('Beta');
    });

    it.each(RESOURCES)(
      'the 404 for /%s of another organization equals the 404 for an unknown id',
      async (path, idOf) => {
        const foreign = await a.api.get(`/${path}/${idOf(b)}`);
        const missingId = randomUUID();
        const missing = await a.api.get(`/${path}/${missingId}`);
        expect(foreign.status).toBe(missing.status);
        expect(foreign.body.code).toBe(missing.body.code);
        expect(foreign.body.message).toBe(
          (missing.body.message as string).replace(missingId, idOf(b)),
        );
      },
    );

    it('GET /organization returns only the caller’s own organization', async () => {
      const response = await a.api.get('/organization');
      expect(response.body).toMatchObject({ id: a.tenant.organization.id, name: 'Alpha' });
    });

    it('scope of a user of another organization is 404', async () => {
      expect((await a.api.get(`/users/${a.user.id}/scope`)).status).toBe(200);
      expect((await a.api.get(`/users/${b.user.id}/scope`)).status).toBe(404);
    });

    it('attachments of a work log of another organization are 404', async () => {
      expect((await a.api.get(`/work-logs/${a.workLog.id}/attachments`)).body.total).toBe(1);
      expect((await a.api.get(`/work-logs/${b.workLog.id}/attachments`)).status).toBe(404);
    });
  });

  describe('lists', () => {
    // path, id of the record created through the API, rows the caller's organization owns
    const LISTS: Array<
      [string, (world: World) => string, (organizationId: string) => Promise<number>]
    > = [
      [
        'users',
        (world) => world.user.id,
        (organizationId) => ctx.prisma.user.count({ where: { organizationId } }),
      ],
      [
        'sites',
        (world) => world.site.id,
        (organizationId) => ctx.prisma.site.count({ where: { organizationId } }),
      ],
      [
        'teams',
        (world) => world.team.id,
        (organizationId) => ctx.prisma.team.count({ where: { organizationId } }),
      ],
      [
        'log-types',
        (world) => world.logType.id,
        (organizationId) => ctx.prisma.logType.count({ where: { organizationId } }),
      ],
      [
        'memberships',
        (world) => world.membership.id,
        (organizationId) => ctx.prisma.membership.count({ where: { organizationId } }),
      ],
      [
        'tasks',
        (world) => world.task.id,
        (organizationId) => ctx.prisma.task.count({ where: { organizationId } }),
      ],
      [
        'work-logs',
        (world) => world.workLog.id,
        (organizationId) => ctx.prisma.workLog.count({ where: { organizationId } }),
      ],
    ];

    it.each(LISTS)('GET /%s lists only the caller’s organization', async (path, idOf, countOwn) => {
      const response = await a.api.get(`/${path}`, { pageSize: 100, includeArchived: true });
      expect(response.status).toBe(200);
      const ids = (response.body.items as Json[]).map((item) => item.id);
      expect(ids).toContain(idOf(a));
      expect(ids).not.toContain(idOf(b));
      expect(response.body.total).toBe(await countOwn(a.tenant.organization.id));
      expect(response.body.total).toBeLessThan(
        (await countOwn(a.tenant.organization.id)) + (await countOwn(b.tenant.organization.id)),
      );
      for (const item of response.body.items as Json[]) {
        expect(item.organizationId).toBe(a.tenant.organization.id);
      }
    });

    it.each([['audit-events'], ['outbox-events']])(
      'GET /%s lists only events of the caller’s organization',
      async (path) => {
        const [mine, theirs] = await Promise.all([
          a.api.get(`/${path}`, { pageSize: 100 }),
          b.api.get(`/${path}`, { pageSize: 100 }),
        ]);
        const stored = {
          a: await eventCounts(ctx.prisma, a.tenant.organization.id),
          b: await eventCounts(ctx.prisma, b.tenant.organization.id),
        };
        const kind = path === 'audit-events' ? 'audit' : 'outbox';
        expect(stored.a[kind]).toBeGreaterThanOrEqual(8);
        expect(mine.body.total).toBe(stored.a[kind]);
        expect(theirs.body.total).toBe(stored.b[kind]);
        const idsOfA = new Set((mine.body.items as Json[]).map((item) => item.id));
        for (const item of mine.body.items as Json[]) {
          expect(item.organizationId).toBe(a.tenant.organization.id);
        }
        for (const item of theirs.body.items as Json[]) {
          expect(item.organizationId).toBe(b.tenant.organization.id);
          expect(idsOfA.has(item.id)).toBe(false);
        }
      },
    );

    it('filtering by an id of the other organization finds nothing', async () => {
      const checks = await Promise.all([
        a.api.get('/tasks', { siteId: b.site.id }),
        a.api.get('/tasks', { teamId: b.team.id }),
        a.api.get('/tasks', { assigneeId: b.user.id }),
        a.api.get('/tasks', { createdById: b.tenant.admin.id }),
        a.api.get('/work-logs', { authorId: b.tenant.admin.id }),
        a.api.get('/work-logs', { siteId: b.site.id }),
        a.api.get('/work-logs', { taskId: b.task.id }),
        a.api.get('/work-logs', { logTypeId: b.logType.id }),
        a.api.get('/memberships', { userId: b.user.id }),
        a.api.get('/memberships', { siteId: b.site.id }),
        a.api.get('/users', { siteId: b.site.id }),
        a.api.get('/users', { teamId: b.team.id }),
        a.api.get('/sites', { parentId: b.site.id }),
        a.api.get('/audit-events', { entityId: b.site.id }),
        a.api.get('/audit-events', { actorId: b.tenant.admin.id }),
        a.api.get('/outbox-events', { aggregateId: b.site.id }),
      ]);
      for (const response of checks) {
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ items: [], total: 0 });
      }
    });

    it('searching by a name used only in the other organization finds nothing', async () => {
      for (const path of ['/sites', '/teams', '/tasks', '/users', '/log-types']) {
        expect((await a.api.get(path, { search: 'Beta' })).body.total).toBe(0);
        expect((await b.api.get(path, { search: 'Beta' })).body.total).toBe(1);
      }
    });

    it('finds an audit trail by correlation id only inside the caller’s organization', async () => {
      const audit = await ctx.prisma.auditEvent.findUniqueOrThrow({
        where: { id: b.auditEventId },
      });
      const correlationId = audit.correlationId as string;
      expect((await b.api.get('/audit-events', { correlationId })).body.total).toBe(1);
      expect((await a.api.get('/audit-events', { correlationId })).body.total).toBe(0);
      expect((await a.api.get('/outbox-events', { afterSequence: '0' })).body.total).toBe(
        (await eventCounts(ctx.prisma, a.tenant.organization.id)).outbox,
      );
    });
  });

  describe('writing', () => {
    const WRITES: Array<
      [string, (world: World) => { method: string; path: string; body?: unknown }]
    > = [
      [
        'update a user',
        (w) => ({ method: 'PATCH', path: `/users/${w.user.id}`, body: { displayName: 'Hacked' } }),
      ],
      ['archive a user', (w) => ({ method: 'POST', path: `/users/${w.user.id}/archive` })],
      ['restore a user', (w) => ({ method: 'POST', path: `/users/${w.user.id}/restore` })],
      [
        'update a site',
        (w) => ({ method: 'PATCH', path: `/sites/${w.site.id}`, body: { name: 'Hacked' } }),
      ],
      ['archive a site', (w) => ({ method: 'POST', path: `/sites/${w.site.id}/archive` })],
      ['restore a site', (w) => ({ method: 'POST', path: `/sites/${w.site.id}/restore` })],
      [
        'update a team',
        (w) => ({ method: 'PATCH', path: `/teams/${w.team.id}`, body: { name: 'Hacked' } }),
      ],
      ['archive a team', (w) => ({ method: 'POST', path: `/teams/${w.team.id}/archive` })],
      [
        'update a log type',
        (w) => ({ method: 'PATCH', path: `/log-types/${w.logType.id}`, body: { name: 'Hacked' } }),
      ],
      [
        'archive a log type',
        (w) => ({ method: 'POST', path: `/log-types/${w.logType.id}/archive` }),
      ],
      [
        'update a membership',
        (w) => ({
          method: 'PATCH',
          path: `/memberships/${w.membership.id}`,
          body: { role: 'admin', orgWide: true },
        }),
      ],
      [
        'archive a membership',
        (w) => ({ method: 'POST', path: `/memberships/${w.membership.id}/archive` }),
      ],
      [
        'update a task',
        (w) => ({ method: 'PATCH', path: `/tasks/${w.task.id}`, body: { title: 'Hacked' } }),
      ],
      [
        'change a task status',
        (w) => ({ method: 'PATCH', path: `/tasks/${w.task.id}/status`, body: { status: 'done' } }),
      ],
      [
        'replace task assignees',
        (w) => ({
          method: 'PUT',
          path: `/tasks/${w.task.id}/assignees`,
          body: { assigneeIds: [] },
        }),
      ],
      ['archive a task', (w) => ({ method: 'POST', path: `/tasks/${w.task.id}/archive` })],
      [
        'update a work log',
        (w) => ({ method: 'PATCH', path: `/work-logs/${w.workLog.id}`, body: { text: 'Hacked' } }),
      ],
      [
        'change a work log status',
        (w) => ({
          method: 'PATCH',
          path: `/work-logs/${w.workLog.id}/status`,
          body: { status: 'rejected' },
        }),
      ],
      [
        'archive a work log',
        (w) => ({ method: 'POST', path: `/work-logs/${w.workLog.id}/archive` }),
      ],
      [
        'attach a file to a work log',
        (w) => ({
          method: 'POST',
          path: `/work-logs/${w.workLog.id}/attachments`,
          body: {
            fileName: 'x.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1,
            storageKey: `intruder/${randomUUID()}`,
          },
        }),
      ],
      [
        'archive an attachment',
        (w) => ({ method: 'POST', path: `/attachments/${w.attachment.id}/archive` }),
      ],
    ];

    it.each(WRITES)(
      'refuses to %s of the other organization (404) and changes nothing',
      async (_name, build) => {
        const before = await snapshotOfB();
        const eventsOfA = await eventCounts(ctx.prisma, a.tenant.organization.id);
        const request = build(b);

        const response = await a.api.request(request.method, request.path, { body: request.body });

        expect(response.status).toBe(404);
        expect(response.body.code).toBe('not_found');
        expect(await snapshotOfB()).toEqual(before);
        expect(await eventCounts(ctx.prisma, a.tenant.organization.id)).toEqual(eventsOfA);
      },
    );

    it('lets the owner make the same writes (the refusals above are about the organization)', async () => {
      const response = await b.api.patch(`/tasks/${b.task.id}`, { description: 'Owner update' });
      expect(response.status).toBe(200);
      await b.api.patch(`/tasks/${b.task.id}`, { description: null });
    });

    it('PATCH /organization changes only the caller’s organization', async () => {
      const before = await ctx.prisma.organization.findUniqueOrThrow({
        where: { id: b.tenant.organization.id },
      });
      const response = await a.api.patch('/organization', { settings: { locale: 'tr-TR' } });
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(a.tenant.organization.id);
      expect(
        await ctx.prisma.organization.findUniqueOrThrow({
          where: { id: b.tenant.organization.id },
        }),
      ).toEqual(before);
    });

    it('refuses references to records of the other organization (422) without saying they exist', async () => {
      const before = await snapshotOfB();
      const cases: Array<[string, unknown, string[]]> = [
        ['/sites', { name: 'Child', parentId: b.site.id }, ['parentId']],
        ['/teams', { name: 'Child', parentId: b.team.id }, ['parentId']],
        ['/memberships', { userId: b.user.id, role: 'worker' }, ['userId']],
        [
          '/memberships',
          { userId: a.user.id, role: 'worker', siteIds: [b.site.id], teamIds: [b.team.id] },
          ['siteIds.0', 'teamIds.0'],
        ],
        ['/tasks', { title: 'T', siteId: b.site.id, teamId: b.team.id }, ['siteId', 'teamId']],
        ['/tasks', { title: 'T', assigneeIds: [a.user.id, b.user.id] }, ['assigneeIds.1']],
        [
          '/work-logs',
          {
            clientId: randomUUID(),
            occurredAt: at().toISOString(),
            authorId: b.user.id,
            siteId: b.site.id,
            teamId: b.team.id,
            taskId: b.task.id,
            logTypeId: b.logType.id,
          },
          ['authorId', 'logTypeId', 'siteId', 'taskId', 'teamId'],
        ],
      ];
      for (const [path, body, paths] of cases) {
        const response = await a.api.post(path, body);
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('unprocessable');
        expect((response.body.details as Json[]).map((detail) => detail.path).sort()).toEqual(
          paths,
        );
        for (const detail of response.body.details as Json[]) {
          expect(detail.message).toMatch(/does not exist in this organization or is archived$/);
        }
      }
      expect(await snapshotOfB()).toEqual(before);
    });

    it('refuses to move own records under records of the other organization', async () => {
      const responses = await Promise.all([
        a.api.patch(`/sites/${a.site.id}`, { parentId: b.site.id }),
        a.api.patch(`/teams/${a.team.id}`, { parentId: b.team.id }),
        a.api.patch(`/tasks/${a.task.id}`, { siteId: b.site.id }),
        a.api.patch(`/work-logs/${a.workLog.id}`, { taskId: b.task.id }),
        a.api.patch(`/memberships/${a.membership.id}`, { siteIds: [b.site.id] }),
        a.api.put(`/tasks/${a.task.id}/assignees`, { assigneeIds: [b.user.id] }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([422, 422, 422, 422, 422, 422]);
      const site = await ctx.prisma.site.findUniqueOrThrow({ where: { id: a.site.id } });
      expect(site.parentId).toBeNull();
    });
  });

  describe('values that are unique per organization, not globally', () => {
    it('lets both organizations use the same email, site code and log type key', async () => {
      // buildWorld created these with identical values in both organizations.
      expect(a.user.email).toBe(b.user.email);
      expect(a.site.code).toBe(b.site.code);
      expect(a.logType.key).toBe(b.logType.key);
      expect(a.user.id).not.toBe(b.user.id);
    });

    it('creates two work logs for the same clientId in two organizations', async () => {
      const body = {
        clientId: randomUUID(),
        occurredAt: at().toISOString(),
        text: 'Same device id',
      };
      const first = await a.api.post('/work-logs', body);
      const second = await b.api.post('/work-logs', body);
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(second.body.id).not.toBe(first.body.id);
      expect(first.body.organizationId).toBe(a.tenant.organization.id);
      expect(second.body.organizationId).toBe(b.tenant.organization.id);
      expect(await ctx.prisma.workLog.count({ where: { clientId: body.clientId } })).toBe(2);

      // And the retry of each stays inside its own organization.
      const retry = await a.api.post('/work-logs', body);
      expect(retry.status).toBe(200);
      expect(retry.body.id).toBe(first.body.id);
    });
  });
});
