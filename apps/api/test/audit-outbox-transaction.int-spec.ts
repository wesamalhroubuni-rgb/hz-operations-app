import { randomUUID } from 'node:crypto';
import { AUDIT_REDACTED, REQUEST_ID_HEADER } from '@ops/shared';
import { AccessService } from '../src/operations/access';
import { ChangeRecorder } from '../src/operations/common/change-recorder';
import { SitesService } from '../src/operations/sites/sites.service';
import { AuditService } from '../src/platform/audit/audit.service';
import { OutboxService } from '../src/platform/outbox/outbox.service';
import {
  at,
  createLogType,
  createSite,
  createTask,
  createTeam,
  createTenant,
  createUser,
  createWorkLog,
  eventCounts,
  createMembership,
  type Tenant,
} from './support/factories';
import { startTestApp, type ApiCaller, type TestApp } from './support/test-app';

// The audit row and the outbox row of a change are written in the transaction of the change:
// all three commit together or none does. Real PostgreSQL, real HTTP.

describe('audit and outbox in the transaction of the change', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let api: ApiCaller;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    api = ctx.as(tenant.admin.id);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => ctx.close());

  const orgId = () => tenant.organization.id;

  async function onlyAudit() {
    const rows = await ctx.prisma.auditEvent.findMany();
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function onlyOutbox() {
    const rows = await ctx.prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  describe('what one write records', () => {
    it('create site: one audit row and one outbox row, same correlation id and actor', async () => {
      const response = await api.post(
        '/sites',
        { name: 'North Depot', code: 'N-01' },
        { headers: { [REQUEST_ID_HEADER]: 'corr-site-1' } },
      );
      expect(response.status).toBe(201);
      const site = response.body;

      const audit = await onlyAudit();
      expect(audit).toMatchObject({
        organizationId: orgId(),
        actorType: 'user',
        actorId: tenant.admin.id,
        action: 'site.created',
        entityType: 'site',
        entityId: site.id,
        before: null,
        after: site,
        changes: null,
        correlationId: 'corr-site-1',
      });

      const outbox = await onlyOutbox();
      expect(outbox).toMatchObject({
        organizationId: orgId(),
        eventType: 'site.created',
        aggregateType: 'site',
        aggregateId: site.id,
        payload: { site },
        actorId: tenant.admin.id,
        correlationId: 'corr-site-1',
        processedAt: null,
      });
      expect(response.requestId).toBe('corr-site-1');
    });

    it('uses the generated correlation id of the request when the caller sends none', async () => {
      const response = await api.post('/sites', { name: 'North Depot' });
      expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect((await onlyAudit()).correlationId).toBe(response.requestId);
      expect((await onlyOutbox()).correlationId).toBe(response.requestId);
    });

    it('update site: before, after and the field-level diff', async () => {
      const site = await createSite(ctx.prisma, orgId(), { name: 'Old name', code: 'N-01' });

      const response = await api.patch(`/sites/${site.id}`, {
        name: 'New name',
        address: 'Dock 4',
      });
      expect(response.status).toBe(200);

      const audit = await onlyAudit();
      expect(audit.action).toBe('site.updated');
      expect(audit.before).toMatchObject({ id: site.id, name: 'Old name', address: null });
      expect(audit.after).toEqual(response.body);
      expect(audit.changes).toEqual({
        name: { from: 'Old name', to: 'New name' },
        address: { from: null, to: 'Dock 4' },
        updatedAt: { from: site.updatedAt.toISOString(), to: response.body.updatedAt },
      });
      const outbox = await onlyOutbox();
      expect(outbox.eventType).toBe('site.updated');
      expect(outbox.payload).toEqual({ site: response.body });
    });

    it('create work log: work_log.created with the log under "workLog"', async () => {
      const response = await api.post(
        '/work-logs',
        { clientId: randomUUID(), occurredAt: at().toISOString(), text: 'Checked the roof' },
        { headers: { [REQUEST_ID_HEADER]: 'corr-log-1' } },
      );
      expect(response.status).toBe(201);

      const audit = await onlyAudit();
      expect(audit).toMatchObject({
        action: 'work_log.created',
        entityType: 'work_log',
        entityId: response.body.id,
        actorId: tenant.admin.id,
        correlationId: 'corr-log-1',
        before: null,
        after: response.body,
      });
      const outbox = await onlyOutbox();
      expect(outbox).toMatchObject({
        eventType: 'work_log.created',
        aggregateType: 'work_log',
        aggregateId: response.body.id,
        payload: { workLog: response.body },
        correlationId: 'corr-log-1',
      });
    });

    it('task status change: task.status_changed with from and to', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);

      const response = await api.patch(
        `/tasks/${task.id}/status`,
        { status: 'done' },
        { headers: { [REQUEST_ID_HEADER]: 'corr-task-1' } },
      );
      expect(response.status).toBe(200);

      const audit = await onlyAudit();
      expect(audit).toMatchObject({
        action: 'task.status_changed',
        entityType: 'task',
        entityId: task.id,
        correlationId: 'corr-task-1',
      });
      expect(audit.before).toMatchObject({ status: 'todo', completedAt: null });
      expect(audit.after).toEqual(response.body);
      expect(audit.changes).toMatchObject({
        status: { from: 'todo', to: 'done' },
        completedAt: { from: null, to: response.body.completedAt },
      });
      expect(Object.keys(audit.changes as object).sort()).toEqual([
        'completedAt',
        'status',
        'updatedAt',
        'version',
      ]);

      const outbox = await onlyOutbox();
      expect(outbox).toMatchObject({
        eventType: 'task.status_changed',
        aggregateType: 'task',
        aggregateId: task.id,
        correlationId: 'corr-task-1',
        payload: { from: 'todo', to: 'done', task: response.body },
      });
    });

    it('records the acting user of each request, not the first one seen', async () => {
      const second = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), second.id, 'manager', { orgWide: true });
      expect((await api.post('/sites', { name: 'A' })).status).toBe(201);
      expect((await ctx.as(second.id).post('/sites', { name: 'B' })).status).toBe(201);

      const audits = await ctx.prisma.auditEvent.findMany({ orderBy: { occurredAt: 'asc' } });
      const outbox = await ctx.prisma.outboxEvent.findMany({ orderBy: { sequence: 'asc' } });
      expect(audits.map((row) => row.actorId)).toEqual([tenant.admin.id, second.id]);
      expect(outbox.map((row) => row.actorId)).toEqual([tenant.admin.id, second.id]);
      expect(new Set(audits.map((row) => row.correlationId)).size).toBe(2);
    });

    it('keeps concurrent requests apart: each pair shares its own correlation id', async () => {
      const names = ['A', 'B', 'C', 'D', 'E', 'F'];
      const responses = await Promise.all(
        names.map((name) =>
          api.post('/sites', { name }, { headers: { [REQUEST_ID_HEADER]: `corr-${name}` } }),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual(names.map(() => 201));

      const audits = await ctx.prisma.auditEvent.findMany();
      const outbox = await ctx.prisma.outboxEvent.findMany();
      expect(audits).toHaveLength(6);
      expect(outbox).toHaveLength(6);
      for (const response of responses) {
        const name = response.body.name as string;
        const audit = audits.find((row) => row.entityId === response.body.id);
        const event = outbox.find((row) => row.aggregateId === response.body.id);
        expect(audit?.correlationId).toBe(`corr-${name}`);
        expect(event?.correlationId).toBe(`corr-${name}`);
      }
    });

    it('attributes a write made outside a request to the system', async () => {
      // Services take the caller from AccessService; outside a request that is the system context.
      const site = await ctx.app
        .get(AccessService)
        .runAsSystem(orgId(), () => ctx.app.get(SitesService).create({ name: 'Seeded site' }));

      expect(await onlyAudit()).toMatchObject({
        actorType: 'system',
        actorId: null,
        correlationId: null,
        action: 'site.created',
        entityId: site.id,
      });
      expect(await onlyOutbox()).toMatchObject({ actorId: null, correlationId: null });
    });

    it.each([
      ['user', '/users', { email: 'new@example.test', displayName: 'New Person' }, 'user'],
      ['team', '/teams', { name: 'Electrical' }, 'team'],
      ['log_type', '/log-types', { key: 'delivery', name: 'Delivery' }, 'logType'],
      ['task', '/tasks', { title: 'Fix the door' }, 'task'],
    ])('names the %s create event and nests the record', async (entity, path, body, key) => {
      const response = await api.post(path, body);
      expect(response.status).toBe(201);
      const audits = await ctx.prisma.auditEvent.findMany({ orderBy: { occurredAt: 'asc' } });
      expect(audits[0]).toMatchObject({
        action: `${entity}.created`,
        entityType: entity,
        entityId: response.body.id,
      });
      // Creating a user also issues the activation code: a security event, audit only.
      expect(audits.slice(1).map((row) => row.action)).toEqual(
        entity === 'user' ? ['auth.code_issued'] : [],
      );
      const outbox = await onlyOutbox();
      expect(outbox.eventType).toBe(`${entity}.created`);
      if (entity !== 'user') {
        expect(outbox.payload).toEqual({ [key]: response.body });
        return;
      }
      // A user is recorded as the stored row: no response-shape fields (profile, roles,
      // activated) and never the activation code of the answer.
      const { id, organizationId, email, phone, username, displayName } = response.body;
      const { memberships, createdAt, updatedAt, archivedAt } = response.body;
      expect(outbox.payload).toEqual({
        user: {
          id,
          organizationId,
          email,
          phone,
          username,
          displayName,
          memberships,
          createdAt,
          updatedAt,
          archivedAt,
        },
      });
      expect(JSON.stringify(outbox.payload)).not.toContain('activation');
    });
  });

  describe('atomicity', () => {
    async function expectNothingWritten() {
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    }

    function expectInternalError(response: {
      status: number;
      body: { code?: string; message?: string };
    }) {
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: 'internal_error',
        message: 'Internal server error',
      });
    }

    it('rolls back the site and the audit row when the outbox write throws', async () => {
      const audit = jest.spyOn(ctx.app.get(AuditService), 'record');
      jest
        .spyOn(ctx.app.get(OutboxService), 'publish')
        .mockRejectedValueOnce(new Error('outbox unavailable (forced by the test)'));

      const response = await api.post('/sites', { name: 'North Depot' });

      expectInternalError(response);
      expect(response.text).not.toContain('outbox unavailable');
      // The audit row was really written inside the transaction before the outbox failed...
      expect(audit).toHaveBeenCalledTimes(1);
      await expect(audit.mock.results[0]?.value).resolves.toBeUndefined();
      // ...and is gone with it.
      expect(await ctx.prisma.site.count()).toBe(0);
      await expectNothingWritten();
    });

    it('rolls back everything when the outbox insert fails in the database', async () => {
      jest.spyOn(ctx.app.get(OutboxService), 'publish').mockImplementationOnce(async (tx) => {
        // A NOT NULL violation raised by PostgreSQL itself, inside the transaction.
        await (tx as unknown as typeof ctx.prisma).$executeRawUnsafe(
          'INSERT INTO "OutboxEvent" ("id") VALUES (gen_random_uuid())',
        );
      });

      const response = await api.post('/sites', { name: 'North Depot' });

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await ctx.prisma.site.count()).toBe(0);
      await expectNothingWritten();
    });

    it('rolls back the site when the audit write throws, and never reaches the outbox', async () => {
      const publish = jest.spyOn(ctx.app.get(OutboxService), 'publish');
      jest
        .spyOn(ctx.app.get(AuditService), 'record')
        .mockRejectedValueOnce(new Error('audit unavailable (forced by the test)'));

      const response = await api.post('/sites', { name: 'North Depot' });

      expectInternalError(response);
      expect(publish).not.toHaveBeenCalled();
      expect(await ctx.prisma.site.count()).toBe(0);
      await expectNothingWritten();
    });

    it('rolls back site, audit row and outbox row when the transaction fails after all three', async () => {
      const recorder = ctx.app.get(ChangeRecorder);
      const original = recorder.record.bind(recorder);
      const insideTransaction = { sites: -1, audit: -1, outbox: -1 };
      jest.spyOn(recorder, 'record').mockImplementationOnce(async (tx, change) => {
        await original(tx, change);
        insideTransaction.sites = await tx.site.count();
        insideTransaction.audit = await tx.auditEvent.count();
        insideTransaction.outbox = await tx.outboxEvent.count();
        throw new Error('failure after both rows (forced by the test)');
      });

      const response = await api.post('/sites', { name: 'North Depot' });

      expectInternalError(response);
      // All three rows existed in the open transaction when it failed.
      expect(insideTransaction).toEqual({ sites: 1, audit: 1, outbox: 1 });
      expect(await ctx.prisma.site.count()).toBe(0);
      await expectNothingWritten();
    });

    it('leaves a task untouched when the event of its status change cannot be written', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      jest.spyOn(ctx.app.get(OutboxService), 'publish').mockRejectedValueOnce(new Error('forced'));

      const response = await api.patch(`/tasks/${task.id}/status`, { status: 'done' });

      expectInternalError(response);
      const stored = await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(stored.status).toBe('todo');
      expect(stored.completedAt).toBeNull();
      expect(stored.updatedAt).toEqual(task.updatedAt);
      await expectNothingWritten();
    });

    it('does not keep a work log whose event failed, and a retry with the same clientId then creates it', async () => {
      const body = { clientId: randomUUID(), occurredAt: at().toISOString(), text: 'Roof check' };
      jest.spyOn(ctx.app.get(OutboxService), 'publish').mockRejectedValueOnce(new Error('forced'));

      const failed = await api.post('/work-logs', body);
      expectInternalError(failed);
      expect(await ctx.prisma.workLog.count()).toBe(0);
      await expectNothingWritten();

      const retried = await api.post('/work-logs', body);
      expect(retried.status).toBe(201);
      expect(await ctx.prisma.workLog.count()).toBe(1);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
    });

    it('restores the scope rows of a membership when its update cannot be recorded', async () => {
      const [siteA, siteB, team] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const worker = await createUser(ctx.prisma, orgId());
      const membership = await createMembership(ctx.prisma, orgId(), worker.id, 'worker', {
        siteIds: [siteA.id],
        teamIds: [team.id],
      });
      jest.spyOn(ctx.app.get(AuditService), 'record').mockRejectedValueOnce(new Error('forced'));

      const response = await api.patch(`/memberships/${membership.id}`, {
        role: 'supervisor',
        siteIds: [siteB.id],
        teamIds: [],
      });

      expectInternalError(response);
      const stored = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: membership.id },
        include: { sites: true, teams: true },
      });
      expect(stored.role).toBe('worker');
      expect(stored.sites.map((row) => row.siteId)).toEqual([siteA.id]);
      expect(stored.teams.map((row) => row.teamId)).toEqual([team.id]);
      await expectNothingWritten();
    });

    it('keeps the assignees of a task when the change cannot be recorded', async () => {
      const [one, two] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        assigneeIds: [one.id],
      });
      jest.spyOn(ctx.app.get(OutboxService), 'publish').mockRejectedValueOnce(new Error('forced'));

      const response = await api.put(`/tasks/${task.id}/assignees`, { assigneeIds: [two.id] });

      expectInternalError(response);
      const assignees = await ctx.prisma.taskAssignee.findMany({ where: { taskId: task.id } });
      expect(assignees.map((row) => row.userId)).toEqual([one.id]);
      await expectNothingWritten();
    });

    it('writes normally again after a failed transaction', async () => {
      jest.spyOn(ctx.app.get(OutboxService), 'publish').mockRejectedValueOnce(new Error('forced'));
      expectInternalError(await api.post('/sites', { name: 'First try' }));

      const response = await api.post('/sites', { name: 'Second try' });
      expect(response.status).toBe(201);
      expect(await ctx.prisma.site.count()).toBe(1);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
    });
  });

  describe('when the business write fails', () => {
    it('records nothing for a duplicate site code (409)', async () => {
      expect((await api.post('/sites', { name: 'First', code: 'N-01' })).status).toBe(201);

      const response = await api.post('/sites', { name: 'Second', code: 'N-01' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('conflict');
      expect(await ctx.prisma.site.count()).toBe(1);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
    });

    it('records nothing for a duplicate log type key (409)', async () => {
      await createLogType(ctx.prisma, orgId(), { key: 'inspection' });
      const response = await api.post('/log-types', { key: 'inspection', name: 'Again' });
      expect(response.status).toBe(409);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('records nothing for a reference to a missing record (422)', async () => {
      const response = await api.post('/tasks', { title: 'Orphan', siteId: randomUUID() });
      expect(response.status).toBe(422);
      expect(await ctx.prisma.task.count()).toBe(0);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('records nothing for a request that fails validation (400)', async () => {
      const logType = await createLogType(ctx.prisma, orgId());
      const response = await api.post('/work-logs', {
        clientId: randomUUID(),
        occurredAt: at().toISOString(),
        logTypeId: logType.id,
        customFields: { area: 'Roof', quantity: 'many' },
      });
      expect(response.status).toBe(400);
      expect(await ctx.prisma.workLog.count()).toBe(0);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('records nothing for a write to an archived record (409) or a missing one (404)', async () => {
      const site = await createSite(ctx.prisma, orgId(), { archivedAt: at() });
      expect((await api.patch(`/sites/${site.id}`, { name: 'Renamed' })).status).toBe(409);
      expect((await api.patch(`/sites/${randomUUID()}`, { name: 'Renamed' })).status).toBe(404);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });
  });

  describe('no-op writes record nothing', () => {
    it('archiving twice records one event and returns the same record', async () => {
      const site = await createSite(ctx.prisma, orgId());

      const first = await api.post(`/sites/${site.id}/archive`);
      const second = await api.post(`/sites/${site.id}/archive`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.archivedAt).not.toBeNull();
      expect(second.body).toEqual(first.body);
      expect((await onlyAudit()).action).toBe('site.archived');
      expect((await onlyOutbox()).eventType).toBe('site.archived');
    });

    it('restoring a record that is not archived records nothing', async () => {
      const site = await createSite(ctx.prisma, orgId());
      const response = await api.post(`/sites/${site.id}/restore`);
      expect(response.status).toBe(200);
      expect(response.body.archivedAt).toBeNull();
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('archive then restore records exactly two events, in order', async () => {
      const site = await createSite(ctx.prisma, orgId());
      await api.post(`/sites/${site.id}/archive`);
      await api.post(`/sites/${site.id}/restore`);
      await api.post(`/sites/${site.id}/restore`);

      const outbox = await ctx.prisma.outboxEvent.findMany({ orderBy: { sequence: 'asc' } });
      expect(outbox.map((row) => row.eventType)).toEqual(['site.archived', 'site.restored']);
      expect(await ctx.prisma.auditEvent.count()).toBe(2);
    });

    it('setting the status a task already has records nothing and changes nothing', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        status: 'blocked',
        statusReason: 'Waiting for parts',
      });

      const response = await api.patch(`/tasks/${task.id}/status`, {
        status: 'blocked',
        reason: 'Waiting for parts',
      });

      expect(response.status).toBe(200);
      expect(response.body.updatedAt).toBe(task.updatedAt.toISOString());
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('setting the status a work log already has records nothing', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const response = await api.patch(`/work-logs/${workLog.id}/status`, { status: 'submitted' });
      expect(response.status).toBe(200);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('sending the assignee list a task already has records nothing, in any order', async () => {
      const [one, two] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        assigneeIds: [one.id, two.id],
      });
      const response = await api.put(`/tasks/${task.id}/assignees`, {
        assigneeIds: [two.id, one.id],
      });
      expect(response.status).toBe(200);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it.each([
      ['users', (t: Tenant) => createUser(ctx.prisma, t.organization.id)],
      ['teams', (t: Tenant) => createTeam(ctx.prisma, t.organization.id)],
      ['log-types', (t: Tenant) => createLogType(ctx.prisma, t.organization.id)],
      ['tasks', (t: Tenant) => createTask(ctx.prisma, t.organization.id, t.admin.id)],
      ['work-logs', (t: Tenant) => createWorkLog(ctx.prisma, t.organization.id, t.admin.id)],
      [
        'memberships',
        (t: Tenant) => createMembership(ctx.prisma, t.organization.id, t.admin.id, 'worker'),
      ],
    ])('archiving %s twice records one event', async (path, create) => {
      const record = await create(tenant);
      const first = await api.post(`/${path}/${record.id}/archive`);
      const second = await api.post(`/${path}/${record.id}/archive`);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.body.archivedAt).toBe(first.body.archivedAt);
      // Archiving a membership also ends the holder's sessions (here: the admin's own, opened
      // by the harness), which is one more audit event and no outbox event.
      const actions = (
        await ctx.prisma.auditEvent.findMany({ orderBy: { occurredAt: 'asc' } })
      ).map((row) => row.action);
      const singular = path.replace(/-/g, '_').slice(0, -1);
      expect(actions).toEqual(
        path === 'memberships'
          ? ['membership.archived', 'auth.session_revoked']
          : [`${singular}.archived`],
      );
      expect((await eventCounts(ctx.prisma)).outbox).toBe(1);
    });
  });

  // The trigger raises SQLSTATE 23001 (restrict_violation). Through the ORM that surfaces as a
  // generic P2003 "foreign key constraint violated" error without the trigger's message, so the
  // ORM tests only assert the rejection and that the row is unchanged; the raw statements show
  // the trigger's own message.
  describe('AuditEvent is append-only', () => {
    async function seedAuditRow() {
      await api.post('/sites', { name: 'North Depot' });
      return onlyAudit();
    }

    it('rejects UPDATE through the ORM', async () => {
      const row = await seedAuditRow();
      await expect(
        ctx.prisma.auditEvent.update({ where: { id: row.id }, data: { action: 'site.tampered' } }),
      ).rejects.toThrow();
      await expect(ctx.prisma.auditEvent.updateMany({ data: { actorId: null } })).rejects.toThrow();
      expect(await onlyAudit()).toEqual(row);
    });

    it('rejects DELETE through the ORM', async () => {
      const row = await seedAuditRow();
      await expect(ctx.prisma.auditEvent.delete({ where: { id: row.id } })).rejects.toThrow();
      await expect(ctx.prisma.auditEvent.deleteMany()).rejects.toThrow();
      expect(await onlyAudit()).toEqual(row);
    });

    it('rejects raw UPDATE and DELETE statements, naming the operation', async () => {
      const row = await seedAuditRow();
      await expect(
        ctx.prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "action" = 'x'`),
      ).rejects.toThrow(/AuditEvent is append-only: UPDATE is not allowed/);
      await expect(ctx.prisma.$executeRawUnsafe('DELETE FROM "AuditEvent"')).rejects.toThrow(
        /AuditEvent is append-only: DELETE is not allowed/,
      );
      expect(await onlyAudit()).toEqual(row);
    });

    it('rolls back a transaction that tries to change the log, with everything else in it', async () => {
      const row = await seedAuditRow();
      await expect(
        ctx.prisma.$transaction(async (tx) => {
          await tx.site.create({ data: { organizationId: orgId(), name: 'Smuggled' } });
          await tx.auditEvent.deleteMany();
        }),
      ).rejects.toThrow();
      expect(await ctx.prisma.site.count({ where: { name: 'Smuggled' } })).toBe(0);
      expect(await onlyAudit()).toEqual(row);
    });

    it('still accepts new rows', async () => {
      await seedAuditRow();
      await api.post('/sites', { name: 'South Depot' });
      expect(await ctx.prisma.auditEvent.count()).toBe(2);
    });

    it('lets a consumer mark an OutboxEvent as processed: the outbox is not append-only', async () => {
      await seedAuditRow();
      const event = await onlyOutbox();
      const marked = await ctx.app
        .get(OutboxService)
        .markProcessed(ctx.prisma, [event.sequence], at(5));
      expect(marked).toBe(1);
      expect((await onlyOutbox()).processedAt).toEqual(at(5));
    });
  });

  describe('redaction of sensitive keys', () => {
    it('stores "[redacted]" for sensitive keys at any depth, in before, after and changes', async () => {
      await ctx.prisma.organization.update({
        where: { id: orgId() },
        data: { settings: { timezone: 'Europe/Istanbul', apiKey: 'old-example-key' } },
      });

      const response = await api.patch('/organization', {
        settings: {
          timezone: 'Europe/Istanbul',
          apiKey: 'new-example-key',
          integrations: [{ name: 'erp', clientSecret: 'example-secret', password: 'example-pw' }],
        },
      });
      expect(response.status).toBe(200);

      const audit = await onlyAudit();
      const stored = JSON.stringify(audit);
      for (const secret of ['old-example-key', 'new-example-key', 'example-secret', 'example-pw']) {
        expect(stored).not.toContain(secret);
      }
      expect(audit.before).toMatchObject({
        settings: { timezone: 'Europe/Istanbul', apiKey: AUDIT_REDACTED },
      });
      expect(audit.after).toMatchObject({
        settings: {
          timezone: 'Europe/Istanbul',
          apiKey: AUDIT_REDACTED,
          integrations: [{ name: 'erp', clientSecret: AUDIT_REDACTED, password: AUDIT_REDACTED }],
        },
      });
      // The diff still shows that the settings changed, with the secrets replaced.
      expect(audit.changes).toMatchObject({
        settings: {
          from: { apiKey: AUDIT_REDACTED },
          to: { apiKey: AUDIT_REDACTED, integrations: [{ clientSecret: AUDIT_REDACTED }] },
        },
      });
    });

    it('redacts through AuditService.record on a real transaction, with per-call extra keys', async () => {
      await ctx.prisma.$transaction((tx) =>
        ctx.app.get(AuditService).record(tx, {
          organizationId: orgId(),
          action: 'thing.updated',
          entityType: 'thing',
          entityId: 't-1',
          before: { name: 'A', passwordHash: 'h1', pin: '1234', nested: { accessToken: 't1' } },
          after: { name: 'B', passwordHash: 'h2', pin: '9999', nested: { accessToken: 't2' } },
          redact: ['PIN'],
        }),
      );

      const audit = await onlyAudit();
      expect(audit.before).toEqual({
        name: 'A',
        passwordHash: AUDIT_REDACTED,
        pin: AUDIT_REDACTED,
        nested: { accessToken: AUDIT_REDACTED },
      });
      expect(audit.changes).toEqual({
        name: { from: 'A', to: 'B' },
        passwordHash: { from: AUDIT_REDACTED, to: AUDIT_REDACTED },
        pin: { from: AUDIT_REDACTED, to: AUDIT_REDACTED },
        nested: { from: { accessToken: AUDIT_REDACTED }, to: { accessToken: AUDIT_REDACTED } },
      });
      expect(audit).toMatchObject({ actorType: 'system', actorId: null, correlationId: null });
    });

    it('redacts the outbox payload of the same change too, in the table and over HTTP', async () => {
      await api.patch('/organization', {
        settings: {
          timezone: 'Europe/Istanbul',
          apiKey: 'new-example-key',
          integrations: [{ name: 'erp', clientSecret: 'example-secret' }],
        },
      });

      const outbox = await onlyOutbox();
      expect(outbox.payload).toMatchObject({
        organization: {
          settings: {
            timezone: 'Europe/Istanbul',
            apiKey: AUDIT_REDACTED,
            integrations: [{ name: 'erp', clientSecret: AUDIT_REDACTED }],
          },
        },
      });
      const read = await api.get('/outbox-events');
      for (const text of [JSON.stringify(outbox.payload), read.text]) {
        expect(text).not.toContain('new-example-key');
        expect(text).not.toContain('example-secret');
      }
      // The record itself is stored and returned as it was sent.
      expect((await api.get('/organization')).body.settings.apiKey).toBe('new-example-key');
    });

    it('redacts through OutboxService.publish on a real transaction, at any depth', async () => {
      await ctx.prisma.$transaction((tx) =>
        ctx.app.get(OutboxService).publish(tx, {
          organizationId: orgId(),
          eventType: 'thing.updated',
          aggregateType: 'thing',
          aggregateId: 't-1',
          payload: {
            from: 'a',
            thing: { name: 'B', passwordHash: 'h2', nested: [{ accessToken: 't2', ok: 1 }] },
          },
        }),
      );
      expect((await onlyOutbox()).payload).toEqual({
        from: 'a',
        thing: {
          name: 'B',
          passwordHash: AUDIT_REDACTED,
          nested: [{ accessToken: AUDIT_REDACTED, ok: 1 }],
        },
      });
    });
  });

  describe('OutboxService against the real table', () => {
    it('reads events after a cursor in sequence order, filtered and limited', async () => {
      const other = await createTenant(ctx.prisma);
      await api.post('/sites', { name: 'A' });
      await api.post('/teams', { name: 'B' });
      await ctx.as(other.admin.id).post('/sites', { name: 'Other org' });
      await api.post('/sites', { name: 'C' });
      const outbox = ctx.app.get(OutboxService);

      const all = await outbox.readAfter(ctx.prisma);
      expect(all.map((row) => row.sequence)).toEqual([1n, 2n, 3n, 4n]);

      const mine = await outbox.readAfter(ctx.prisma, { organizationId: orgId() });
      expect(mine.map((row) => row.sequence)).toEqual([1n, 2n, 4n]);

      const afterFirst = await outbox.readAfter(ctx.prisma, {
        organizationId: orgId(),
        afterSequence: 1n,
        eventTypes: ['site.created'],
      });
      expect(afterFirst.map((row) => row.sequence)).toEqual([4n]);

      const limited = await outbox.readAfter(ctx.prisma, { limit: 2 });
      expect(limited.map((row) => row.sequence)).toEqual([1n, 2n]);
      expect(await outbox.readAfter(ctx.prisma, { afterSequence: 4n })).toEqual([]);
    });

    it('marks events once and keeps the first processing time', async () => {
      await api.post('/sites', { name: 'A' });
      await api.post('/sites', { name: 'B' });
      const outbox = ctx.app.get(OutboxService);

      expect(await outbox.markProcessed(ctx.prisma, [1n], at(1))).toBe(1);
      expect(await outbox.markProcessed(ctx.prisma, [1n, 2n], at(2))).toBe(1);
      expect(await outbox.markProcessed(ctx.prisma, [1n, 2n, 99n], at(3))).toBe(0);

      const rows = await ctx.prisma.outboxEvent.findMany({ orderBy: { sequence: 'asc' } });
      expect(rows.map((row) => row.processedAt)).toEqual([at(1), at(2)]);
    });
  });
});
