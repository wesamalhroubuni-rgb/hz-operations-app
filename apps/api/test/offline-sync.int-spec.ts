import { randomUUID } from 'node:crypto';
import {
  auditMetadataSchema,
  DECLARED_ATTACHMENT_GRACE_DAYS,
  IDEMPOTENCY_LOCK_SECONDS,
  MAX_DECLARED_ATTACHMENTS,
  syncPullResponseSchema,
  WORK_LOG_MAX_FUTURE_MS,
  workLogSchema,
} from '@ops/shared';
import { IdempotencyService, idempotencyRequestHash } from '../src/platform/idempotency';
import {
  at,
  createLogType,
  createMembership,
  createSite,
  createTask,
  createTenant,
  createUser,
  createWorkLog,
  type Tenant,
} from './support/factories';
import { makeJpeg } from './support/test-images';
import { startTestApp, type ApiCaller, type ApiResponse, type TestApp } from './support/test-app';

// Phase 5 (ADR-0008): Idempotency-Key, optimistic concurrency and the typed codes, the
// offline-submission facts and audit metadata, photos declared with an offline log, and
// GET /sync/pull. The scope of a pull per role is in permissions-matrix.int-spec.ts.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('offline mode and sync', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let orgId: string;
  /** Site S: worker W, worker W2, supervisor SUP. Site O: nobody but OTHER_SUP. */
  let siteId: string;
  let otherSiteId: string;
  let W: string;
  let W2: string;
  let SUP: string;
  let OTHER_SUP: string;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    orgId = tenant.organization.id;
    siteId = (await createSite(ctx.prisma, orgId)).id;
    otherSiteId = (await createSite(ctx.prisma, orgId)).id;
    const user = async (role: 'worker' | 'supervisor', site: string) => {
      const created = await createUser(ctx.prisma, orgId);
      await createMembership(ctx.prisma, orgId, created.id, role, { siteIds: [site] });
      return created.id;
    };
    W = await user('worker', siteId);
    W2 = await user('worker', siteId);
    SUP = await user('supervisor', siteId);
    OTHER_SUP = await user('supervisor', otherSiteId);
  });
  afterAll(() => ctx.close());

  const as = (userId: string): ApiCaller => ctx.as(userId);

  /** The headers the phone's queue sends (`offlineSyncHeaders` in @ops/shared). */
  function offline(options: { deviceTime?: Date | string; key?: string } = {}) {
    const deviceTime = options.deviceTime ?? new Date();
    return {
      'x-client-sync': 'offline',
      'x-device-time': typeof deviceTime === 'string' ? deviceTime : deviceTime.toISOString(),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    };
  }

  function logBody(extra: Record<string, unknown> = {}) {
    return {
      clientId: randomUUID(),
      occurredAt: new Date(Date.now() - HOUR).toISOString(),
      siteId,
      text: 'Checked the pump',
      ...extra,
    };
  }

  async function createLog(
    userId: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<ApiResponse> {
    return as(userId).post('/work-logs', logBody(extra), { headers });
  }

  async function assignedTask(data: Record<string, unknown> = {}) {
    return createTask(ctx.prisma, orgId, SUP, { siteId, assigneeIds: [W], ...data });
  }

  const auditsOf = (action: string) =>
    ctx.prisma.auditEvent.findMany({ where: { action }, orderBy: { occurredAt: 'asc' } });

  describe('Idempotency-Key', () => {
    it('replays a task status change with the stored answer and records it once', async () => {
      const task = await assignedTask();
      const key = randomUUID();
      const path = `/tasks/${task.id}/status`;
      const first = await as(W).patch(
        path,
        { status: 'in_progress' },
        { headers: { 'idempotency-key': key } },
      );
      expect(first.status).toBe(200);
      expect(first.headers.get('idempotent-replayed')).toBeNull();
      expect(first.body.version).toBe(2);

      // The supervisor changes it meanwhile: the replay still answers what the first one did.
      await as(SUP).patch(path, { status: 'blocked', reason: 'No ladder' });
      const again = await as(W).patch(
        path,
        { status: 'in_progress' },
        { headers: { 'idempotency-key': key } },
      );
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await auditsOf('task.status_changed')).toHaveLength(2);
      const stored = await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(stored.status).toBe('blocked');
    });

    it('replays a work-log create with its 201', async () => {
      const key = randomUUID();
      const body = logBody();
      const first = await as(W).post('/work-logs', body, { headers: { 'idempotency-key': key } });
      const again = await as(W).post('/work-logs', body, { headers: { 'idempotency-key': key } });
      expect([first.status, again.status]).toEqual([201, 201]);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body.id).toBe(first.body.id);
      expect(await ctx.prisma.workLog.count()).toBe(1);
    });

    it('stores and replays a final refusal', async () => {
      const log = await createWorkLog(ctx.prisma, orgId, W, { siteId, status: 'approved' });
      const key = randomUUID();
      const send = () =>
        as(W).patch(
          `/work-logs/${log.id}`,
          { text: 'late' },
          { headers: { 'idempotency-key': key } },
        );
      const first = await send();
      expect([first.status, first.body.code]).toEqual([409, 'already_reviewed']);
      const again = await send();
      expect([again.status, again.body.code]).toEqual([409, 'already_reviewed']);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
    });

    it('refuses the same key with another request: 422 idempotency_key_reused', async () => {
      const task = await assignedTask();
      const key = randomUUID();
      const headers = { 'idempotency-key': key };
      expect(
        (await as(W).patch(`/tasks/${task.id}/status`, { status: 'in_progress' }, { headers }))
          .status,
      ).toBe(200);
      const other = await as(W).patch(`/tasks/${task.id}/status`, { status: 'done' }, { headers });
      expect([other.status, other.body.code]).toEqual([422, 'idempotency_key_reused']);
      const otherRoute = await createLog(W, {}, headers);
      expect([otherRoute.status, otherRoute.body.code]).toEqual([422, 'idempotency_key_reused']);
      expect((await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
        'in_progress',
      );
    });

    it('answers 409 request_in_progress while the first holds the key, then takes over a dead claim', async () => {
      const task = await assignedTask();
      const key = randomUUID();
      const path = `/tasks/${task.id}/status`;
      const body = { status: 'done' };
      const now = ctx.clock.now();
      await ctx.prisma.idempotencyRecord.create({
        data: {
          organizationId: orgId,
          userId: W,
          key,
          method: 'PATCH',
          path,
          requestHash: idempotencyRequestHash('PATCH', path, body),
          lockedUntil: new Date(now.getTime() + IDEMPOTENCY_LOCK_SECONDS * 1000),
          expiresAt: new Date(now.getTime() + 14 * DAY),
        },
      });
      const busy = await as(W).patch(path, body, { headers: { 'idempotency-key': key } });
      expect([busy.status, busy.body.code]).toEqual([409, 'request_in_progress']);
      expect((await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
        'todo',
      );

      // The first request's process died: once the lock ran out, a retry runs it.
      ctx.clock.advanceSeconds(IDEMPOTENCY_LOCK_SECONDS + 1);
      const retried = await as(W).patch(path, body, { headers: { 'idempotency-key': key } });
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('done');
      const record = await ctx.prisma.idempotencyRecord.findFirstOrThrow({ where: { key } });
      expect(record.statusCode).toBe(200);
    });

    it('keeps keys per user: the same key of another user is a different key', async () => {
      const key = randomUUID();
      const headers = { 'idempotency-key': key };
      expect((await createLog(W, {}, headers)).status).toBe(201);
      expect((await createLog(SUP, {}, headers)).status).toBe(201);
      expect(await ctx.prisma.workLog.count()).toBe(2);
    });

    it('refuses a key that is not a UUID (400) and ignores the header on other routes', async () => {
      const task = await assignedTask();
      const bad = await as(W).patch(
        `/tasks/${task.id}/status`,
        { status: 'done' },
        {
          headers: { 'idempotency-key': 'abc' },
        },
      );
      expect(bad.status).toBe(400);
      const headers = { 'idempotency-key': randomUUID() };
      expect((await as(SUP).patch(`/tasks/${task.id}`, { title: 'One' }, { headers })).status).toBe(
        200,
      );
      const second = await as(SUP).patch(`/tasks/${task.id}`, { title: 'Two' }, { headers });
      expect(second.status).toBe(200);
      expect(second.body.title).toBe('Two');
      expect(await ctx.prisma.idempotencyRecord.count()).toBe(0);
    });

    it('deletes keys past their retention, and treats an expired key as new', async () => {
      const task = await assignedTask();
      const key = randomUUID();
      const headers = { 'idempotency-key': key };
      await as(W).patch(`/tasks/${task.id}/status`, { status: 'in_progress' }, { headers });
      ctx.clock.advanceDays(15);
      const reused = await as(W).patch(`/tasks/${task.id}/status`, { status: 'done' }, { headers });
      expect(reused.status).toBe(200);
      expect(reused.body.status).toBe('done');
      ctx.clock.advanceDays(15);
      expect(await ctx.app.get(IdempotencyService).deleteExpired()).toBe(1);
      expect(await ctx.prisma.idempotencyRecord.count()).toBe(0);
    });
  });

  describe('optimistic concurrency', () => {
    it('raises a task version on every change', async () => {
      const task = await assignedTask();
      const versions = [
        (await as(SUP).patch(`/tasks/${task.id}`, { title: 'Renamed' })).body.version,
        (await as(SUP).put(`/tasks/${task.id}/assignees`, { assigneeIds: [W, W2] })).body.version,
        (await as(W).patch(`/tasks/${task.id}/status`, { status: 'in_progress' })).body.version,
        (await as(SUP).post(`/tasks/${task.id}/archive`)).body.version,
      ];
      expect(versions).toEqual([2, 3, 4, 5]);
    });

    it('raises a work log version on every change, and the outbox carries it', async () => {
      const created = await createLog(W);
      const id = created.body.id as string;
      expect(created.body.version).toBe(1);
      const versions = [
        (await as(W).patch(`/work-logs/${id}`, { text: 'Edited' })).body.version,
        (await as(W).patch(`/work-logs/${id}/status`, { status: 'draft' })).body.version,
        (await as(W).patch(`/work-logs/${id}/status`, { status: 'submitted' })).body.version,
        (await as(SUP).patch(`/work-logs/${id}/status`, { status: 'approved' })).body.version,
        (await as(SUP).post(`/work-logs/${id}/archive`)).body.version,
      ];
      expect(versions).toEqual([2, 3, 4, 5, 6]);
      const event = await ctx.prisma.outboxEvent.findFirstOrThrow({
        where: { eventType: 'work_log.archived' },
      });
      expect((event.payload as { workLog: { version: number } }).workLog.version).toBe(6);
    });

    it('edit: 409 version_conflict on a stale version, 200 when the edit is already in place', async () => {
      const id = (await createLog(W)).body.id as string;
      const path = `/work-logs/${id}`;
      expect((await as(W).patch(path, { text: 'A', expectedVersion: 1 })).body.version).toBe(2);
      const stale = await as(W).patch(path, { text: 'B', expectedVersion: 1 });
      expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
      expect(stale.body.details).toEqual([
        { path: 'expectedVersion', message: 'the current version is 2' },
      ]);
      // A resend of the first edit (its answer was lost): nothing to do, 200, nothing recorded.
      const resend = await as(W).patch(path, { text: 'A', expectedVersion: 1 });
      expect([resend.status, resend.body.version, resend.body.text]).toEqual([200, 2, 'A']);
      expect(await auditsOf('work_log.updated')).toHaveLength(1);
      expect((await as(W).patch(path, { text: 'B', expectedVersion: 2 })).status).toBe(200);
    });

    it('edit of a log rejected meanwhile: 409 version_conflict', async () => {
      const id = (await createLog(W)).body.id as string;
      await as(SUP).patch(`/work-logs/${id}/status`, { status: 'rejected', note: 'Wrong pump' });
      const edit = await as(W).patch(`/work-logs/${id}`, {
        text: 'Offline edit',
        expectedVersion: 1,
      });
      expect([edit.status, edit.body.code]).toEqual([409, 'version_conflict']);
    });

    it('edit after approval: 409 already_reviewed, whatever the version', async () => {
      const id = (await createLog(W)).body.id as string;
      const approved = await as(SUP).patch(`/work-logs/${id}/status`, { status: 'approved' });
      for (const expectedVersion of [1, approved.body.version]) {
        const edit = await as(W).patch(`/work-logs/${id}`, { text: 'x', expectedVersion });
        expect([edit.status, edit.body.code]).toEqual([409, 'already_reviewed']);
      }
    });

    it('edit after the edit window: 403 edit_window_closed', async () => {
      const id = (await createLog(W)).body.id as string;
      ctx.clock.advance(25 * HOUR);
      const edit = await as(W).patch(`/work-logs/${id}`, { text: 'late', expectedVersion: 1 });
      expect([edit.status, edit.body.code]).toEqual([403, 'edit_window_closed']);
      const move = await as(W).patch(`/work-logs/${id}/status`, { status: 'draft' });
      expect([move.status, move.body.code]).toEqual([403, 'edit_window_closed']);
    });

    it('log status: stale version 409, the status it already has 200', async () => {
      const id = (await createLog(W)).body.id as string;
      await as(W).patch(`/work-logs/${id}`, { text: 'v2' });
      const stale = await as(W).patch(`/work-logs/${id}/status`, {
        status: 'draft',
        expectedVersion: 1,
      });
      expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
      const same = await as(W).patch(`/work-logs/${id}/status`, {
        status: 'submitted',
        expectedVersion: 1,
      });
      expect([same.status, same.body.version]).toEqual([200, 2]);
    });

    it('task status: the supervisor change wins (version_conflict), a resend of the same status is 200', async () => {
      const task = await assignedTask();
      const path = `/tasks/${task.id}/status`;
      await as(SUP).patch(path, { status: 'blocked', reason: 'No ladder' });
      const mine = await as(W).patch(path, { status: 'in_progress', expectedVersion: 1 });
      expect([mine.status, mine.body.code]).toEqual([409, 'version_conflict']);
      const same = await as(W).patch(path, {
        status: 'blocked',
        reason: 'No ladder',
        expectedVersion: 1,
      });
      expect([same.status, same.body.version]).toEqual([200, 2]);
      expect((await as(W).patch(path, { status: 'in_progress', expectedVersion: 2 })).status).toBe(
        200,
      );
    });

    it('task status: cancelled 409 task_cancelled, reassigned away 404, archived 409 record_archived', async () => {
      const cancelled = await assignedTask({ status: 'cancelled' });
      const onCancelled = await as(W).patch(`/tasks/${cancelled.id}/status`, { status: 'done' });
      expect([onCancelled.status, onCancelled.body.code]).toEqual([409, 'task_cancelled']);

      const reassigned = await assignedTask();
      await as(SUP).put(`/tasks/${reassigned.id}/assignees`, { assigneeIds: [W2] });
      const gone = await as(W).patch(`/tasks/${reassigned.id}/status`, { status: 'done' });
      expect([gone.status, gone.body.code]).toEqual([404, 'not_found']);

      const archived = await assignedTask({ archivedAt: new Date() });
      const onArchived = await as(W).patch(`/tasks/${archived.id}/status`, { status: 'done' });
      expect([onArchived.status, onArchived.body.code]).toEqual([409, 'record_archived']);
    });

    it('task status: 403 task_not_assigned for a supervisor who sees but does not manage it', async () => {
      // On the other site, assigned to W: SUP sees it (W is one of SUP's people) but cannot
      // manage it there and is not an assignee. The site's own supervisor may.
      const task = await createTask(ctx.prisma, orgId, tenant.admin.id, {
        siteId: otherSiteId,
        assigneeIds: [W],
      });
      const refused = await as(SUP).patch(`/tasks/${task.id}/status`, { status: 'done' });
      expect([refused.status, refused.body.code]).toEqual([403, 'task_not_assigned']);
      expect(
        (await as(OTHER_SUP).patch(`/tasks/${task.id}/status`, { status: 'done' })).status,
      ).toBe(200);
      expect(
        (await as(W).patch(`/tasks/${task.id}/status`, { status: 'in_progress' })).status,
      ).toBe(200);
    });
  });

  describe('offline creates', () => {
    it('records the offline facts on the log and offline_sync metadata on the audit event', async () => {
      const deviceTime = new Date(Date.now() + 10 * 60_000);
      const deviceCreatedAt = new Date(Date.now() - 2 * HOUR).toISOString();
      const declared = [randomUUID(), randomUUID()];
      const response = await createLog(
        W,
        { deviceCreatedAt, attachmentClientIds: declared },
        offline({ deviceTime }),
      );
      expect(response.status).toBe(201);
      expect(workLogSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        submittedOffline: true,
        deviceCreatedAt,
        clockSkewFlagged: true,
        declaredAttachmentClientIds: declared,
      });
      expect(Math.abs(response.body.clockSkewSeconds - 600)).toBeLessThanOrEqual(5);

      const [audit] = await auditsOf('work_log.created');
      const metadata = auditMetadataSchema.parse(audit?.metadata);
      expect(metadata).toMatchObject({ via: 'offline_sync', deviceTime: deviceTime.toISOString() });
      expect(Math.abs((metadata.clockSkewSeconds ?? 0) - 600)).toBeLessThanOrEqual(5);
      expect(Math.abs(Date.parse(metadata.serverTime) - Date.now())).toBeLessThan(60_000);
      expect(metadata.droppedReferences).toBeUndefined();
    });

    it('records nothing of the kind for an ordinary request', async () => {
      const response = await createLog(W);
      expect(response.body).toMatchObject({
        submittedOffline: false,
        clockSkewSeconds: null,
        clockSkewFlagged: false,
        deviceCreatedAt: null,
        declaredAttachmentClientIds: [],
      });
      const [audit] = await auditsOf('work_log.created');
      expect(audit?.metadata).toBeNull();
    });

    it('marks every write of an offline request, with a null device time when it is unreadable', async () => {
      const task = await assignedTask();
      await as(W).patch(
        `/tasks/${task.id}/status`,
        { status: 'done' },
        {
          headers: offline({ deviceTime: 'not a time' }),
        },
      );
      const [audit] = await auditsOf('task.status_changed');
      expect(audit?.metadata).toMatchObject({
        via: 'offline_sync',
        deviceTime: null,
        clockSkewSeconds: null,
      });
    });

    it('drops a task or site no longer usable instead of refusing the log, and says so', async () => {
      const notMine = await createTask(ctx.prisma, orgId, SUP, { siteId, assigneeIds: [W2] });
      const archivedSite = await createSite(ctx.prisma, orgId, { archivedAt: new Date() });
      await createMembership(ctx.prisma, orgId, W, 'worker', { siteIds: [archivedSite.id] });
      const refs = { taskId: notMine.id, siteId: archivedSite.id };

      const online = await createLog(W, refs);
      expect(online.status).toBe(422);

      const response = await createLog(W, refs, offline());
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ taskId: null, siteId: null, submittedOffline: true });
      const [audit] = await auditsOf('work_log.created');
      const metadata = audit?.metadata as { droppedReferences: string[] };
      expect([...metadata.droppedReferences].sort()).toEqual(['siteId', 'taskId']);
    });

    it('accepts an archived log type offline, refuses it online (422)', async () => {
      const logType = await createLogType(ctx.prisma, orgId, {
        fields: [],
        archivedAt: new Date(),
      });
      expect((await createLog(W, { logTypeId: logType.id })).status).toBe(422);
      const response = await createLog(W, { logTypeId: logType.id }, offline());
      expect(response.status).toBe(201);
      expect(response.body.logTypeId).toBe(logType.id);
      expect((await createLog(W, { logTypeId: randomUUID() }, offline())).status).toBe(422);
    });

    it('refuses an offline log older than the backdating limit, but returns an existing clientId first', async () => {
      const old = new Date(Date.now() - 8 * DAY).toISOString();
      const refused = await createLog(W, { occurredAt: old }, offline());
      expect([refused.status, refused.body.code]).toEqual([422, 'occurred_at_out_of_range']);

      const body = logBody({ occurredAt: new Date(Date.now() - 6 * DAY).toISOString() });
      expect((await as(W).post('/work-logs', body, { headers: offline() })).status).toBe(201);
      // The answer was lost; the phone resends days later, when the date is out of range.
      ctx.clock.advanceDays(5);
      const resend = await as(W).post('/work-logs', body, { headers: offline() });
      expect(resend.status).toBe(200);
      expect(await ctx.prisma.workLog.count()).toBe(1);
    });
  });

  describe('organization setting offlineMaxBackdateDays', () => {
    it('is set by an admin within 1 to 90 whole days and shown in the summary', async () => {
      const set = await as(tenant.admin.id).patch('/organization', {
        settings: { offlineMaxBackdateDays: 30 },
      });
      expect(set.status).toBe(200);
      expect(set.body.offlineMaxBackdateDays).toBe(30);
      expect((await as(W).get('/organization')).body.offlineMaxBackdateDays).toBe(30);
      for (const value of [0, 91, 2.5, '7']) {
        const bad = await as(tenant.admin.id).patch('/organization', {
          settings: { offlineMaxBackdateDays: value },
        });
        expect([value, bad.status]).toEqual([value, 400]);
      }
    });

    it('is refused to anybody but an admin (403)', async () => {
      for (const userId of [W, SUP]) {
        const response = await as(userId).patch('/organization', {
          settings: { offlineMaxBackdateDays: 30 },
        });
        expect(response.status).toBe(403);
      }
    });
  });

  describe('photos declared with an offline log', () => {
    const A1 = randomUUID();
    const A2 = randomUUID();
    const photo = (clientId?: string, sizeBytes = 2048) => ({
      ...(clientId ? { clientId } : {}),
      fileName: 'pump.jpg',
      mimeType: 'image/jpeg',
      sizeBytes,
    });

    async function lateOfflineLog(): Promise<string> {
      const created = await createLog(W, { attachmentClientIds: [A1, A2] }, offline());
      expect(created.status).toBe(201);
      ctx.clock.advance(2 * DAY); // the 24-hour edit window has closed
      return created.body.id as string;
    }

    it('accepts a declared photo after the window; a repeated start returns the same attachment', async () => {
      const id = await lateOfflineLog();
      const bytes = await makeJpeg();
      const started = await as(W).post(`/work-logs/${id}/attachments`, photo(A1, bytes.byteLength));
      expect(started.status).toBe(201);
      expect(started.body.attachment).toMatchObject({ clientId: A1, status: 'pending' });

      const repeated = await as(W).post(
        `/work-logs/${id}/attachments`,
        photo(A1, bytes.byteLength),
      );
      expect(repeated.status).toBe(200);
      expect(repeated.body.attachment.id).toBe(started.body.attachment.id);
      expect(repeated.body.upload).not.toBeNull();

      ctx.storage.uploadTo(repeated.body.upload.url, bytes);
      const completed = await as(W).post(`/attachments/${started.body.attachment.id}/complete`);
      expect([completed.status, completed.body.status]).toEqual([200, 'ready']);

      const afterReady = await as(W).post(
        `/work-logs/${id}/attachments`,
        photo(A1, bytes.byteLength),
      );
      expect(afterReady.status).toBe(200);
      expect(afterReady.body.upload).toBeNull();
      expect(afterReady.body.attachment.status).toBe('ready');
      expect(await ctx.prisma.attachment.count()).toBe(1);
    });

    it('refuses an undeclared photo after the window: 403 attachment_not_declared', async () => {
      const id = await lateOfflineLog();
      for (const body of [photo(randomUUID()), photo()]) {
        const refused = await as(W).post(`/work-logs/${id}/attachments`, body);
        expect([refused.status, refused.body.code]).toEqual([403, 'attachment_not_declared']);
      }
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('refuses a declared photo after the 30 days: 403 edit_window_closed', async () => {
      const id = await lateOfflineLog();
      ctx.clock.advance(29 * DAY);
      const refused = await as(W).post(`/work-logs/${id}/attachments`, photo(A2));
      expect([refused.status, refused.body.code]).toEqual([403, 'edit_window_closed']);
    });

    it('accepts a declared photo on a log approved before it arrived', async () => {
      const id = await lateOfflineLog();
      expect((await as(SUP).patch(`/work-logs/${id}/status`, { status: 'approved' })).status).toBe(
        200,
      );
      expect((await as(W).post(`/work-logs/${id}/attachments`, photo(A1))).status).toBe(201);
    });

    it('refuses a declared photo on an archived log (409 record_archived)', async () => {
      const id = await lateOfflineLog();
      await as(SUP).post(`/work-logs/${id}/archive`);
      const refused = await as(W).post(`/work-logs/${id}/attachments`, photo(A1));
      expect([refused.status, refused.body.code]).toEqual([409, 'record_archived']);
    });

    it('never lets a clientId serve two logs or two people (409)', async () => {
      const id = await lateOfflineLog();
      expect((await as(W).post(`/work-logs/${id}/attachments`, photo(A1))).status).toBe(201);
      const otherLog = (await createLog(W)).body.id as string;
      const onOtherLog = await as(W).post(`/work-logs/${otherLog}/attachments`, photo(A1));
      expect([onOtherLog.status, onOtherLog.body.code]).toEqual([409, 'conflict']);
      const ofW2 = (await createLog(W2)).body.id as string;
      const byW2 = await as(W2).post(`/work-logs/${ofW2}/attachments`, photo(A1));
      expect([byW2.status, byW2.body.code]).toEqual([409, 'conflict']);
    });

    it('leaves the reviewer rule unchanged: a supervisor may add a photo after the window', async () => {
      const id = await lateOfflineLog();
      expect((await as(SUP).post(`/work-logs/${id}/attachments`, photo())).status).toBe(201);
    });
  });

  describe('GET /sync/pull', () => {
    const pull = async (userId: string, cursor?: string) => {
      const response = await as(userId).get('/sync/pull', cursor ? { cursor } : {});
      expect(response.status).toBe(200);
      expect(syncPullResponseSchema.safeParse(response.body).success).toBe(true);
      return response.body as {
        cursor: string;
        full: boolean;
        organization: { offlineMaxBackdateDays: number };
        tasks: { upserts: { id: string }[]; ids: string[] };
        workLogs: { upserts: { id: string }[]; ids: string[] };
        sites: { ids: string[] };
        logTypes: { ids: string[] };
        notifications: { upserts: { id: string }[]; ids: string[] };
      };
    };
    const ids = (items: { id: string }[]) => items.map((item) => item.id).sort();

    /** Every row looks unchanged for ten minutes, so a delta holds only what changes next. */
    async function settle(): Promise<void> {
      const past = new Date(Date.now() - 10 * 60_000);
      await ctx.prisma.task.updateMany({ data: { updatedAt: past } });
      await ctx.prisma.workLog.updateMany({ data: { updatedAt: past } });
    }

    it('sends the worker their assigned tasks and own logs only', async () => {
      const mine = await assignedTask();
      await createTask(ctx.prisma, orgId, SUP, { siteId, assigneeIds: [W2] });
      const own = await createWorkLog(ctx.prisma, orgId, W, { siteId });
      await createWorkLog(ctx.prisma, orgId, W2, { siteId });
      const body = await pull(W);
      expect(body.full).toBe(true);
      expect(body.tasks.ids).toEqual([mine.id]);
      expect(body.workLogs.ids).toEqual([own.id]);
      expect(body.organization.offlineMaxBackdateDays).toBe(7);
    });

    it("sends a supervisor their own logs and assigned tasks, not their people's", async () => {
      await assignedTask();
      await createWorkLog(ctx.prisma, orgId, W, { siteId });
      const own = await createWorkLog(ctx.prisma, orgId, SUP, { siteId });
      const body = await pull(SUP);
      expect(body.tasks.ids).toEqual([]);
      expect(body.workLogs.ids).toEqual([own.id]);
      expect(body.sites.ids).toContain(siteId);
      expect(body.sites.ids).not.toContain(otherSiteId);
    });

    it('never sends another organization', async () => {
      const other = await createTenant(ctx.prisma, 'Other Org');
      const foreignType = await createLogType(ctx.prisma, other.organization.id);
      await createWorkLog(ctx.prisma, other.organization.id, other.admin.id);
      const body = await pull(W);
      expect(body.logTypes.ids).not.toContain(foreignType.id);
      expect(await pull(other.admin.id)).toMatchObject({ tasks: { ids: [] } });
    });

    it('sends only what changed since the cursor, and the full id sets', async () => {
      const task = await assignedTask();
      const log = await createWorkLog(ctx.prisma, orgId, W, { siteId });
      await settle();
      const first = await pull(W);
      expect(ids(first.tasks.upserts)).toEqual([task.id]);

      await as(SUP).patch(`/tasks/${task.id}/status`, { status: 'in_progress' });
      const delta = await pull(W, first.cursor);
      expect(delta.full).toBe(false);
      expect(ids(delta.tasks.upserts)).toEqual([task.id]);
      expect(delta.workLogs.upserts).toEqual([]);
      expect(delta.workLogs.ids).toEqual([log.id]);
      expect(delta.tasks.ids).toEqual([task.id]);
    });

    it('re-sends a change stamped just before the previous pull (the overlap)', async () => {
      const task = await assignedTask();
      await settle();
      const first = await pull(W);
      // A transaction that stamped updatedAt 30 s before the pull but committed after it.
      await ctx.prisma.task.update({
        where: { id: task.id },
        data: { title: 'Late commit', updatedAt: new Date(Date.now() - 30_000) },
      });
      const delta = await pull(W, first.cursor);
      expect(ids(delta.tasks.upserts)).toEqual([task.id]);
    });

    it('prunes through ids: a reassigned task, an archived log, an aged-out finished task', async () => {
      const task = await assignedTask();
      const finished = await assignedTask({ status: 'done' });
      const log = (await createLog(W)).body.id as string;
      const first = await pull(W);
      expect(first.tasks.ids.sort()).toEqual([task.id, finished.id].sort());
      expect(first.workLogs.ids).toEqual([log]);

      await as(SUP).put(`/tasks/${task.id}/assignees`, { assigneeIds: [W2] });
      await as(W).post(`/work-logs/${log}/archive`);
      await ctx.prisma.task.update({
        where: { id: finished.id },
        data: { updatedAt: new Date(Date.now() - 31 * DAY) },
      });
      const next = await pull(W, first.cursor);
      expect(next.tasks.ids).toEqual([]);
      expect(next.workLogs.ids).toEqual([]);
    });

    it('drops own logs older than the window', async () => {
      const old = new Date(Date.now() - 31 * DAY);
      await createWorkLog(ctx.prisma, orgId, W, { occurredAt: old, createdAt: old });
      expect((await pull(W)).workLogs.ids).toEqual([]);
    });

    it('answers a full pull when the scope changed, or the cursor is unusable', async () => {
      const first = await pull(W);
      expect((await pull(W, first.cursor)).full).toBe(false);
      await createMembership(ctx.prisma, orgId, W, 'worker', { siteIds: [otherSiteId] });
      const after = await pull(W, first.cursor);
      expect(after.full).toBe(true);
      expect(after.sites.ids).toContain(otherSiteId);

      expect((await pull(W, 'not-a-cursor')).full).toBe(true);
      // Another user's cursor is another scope.
      expect((await pull(W, (await pull(W2)).cursor)).full).toBe(true);
      expect((await as(W).get('/sync/pull', { cursor: 'x'.repeat(513) })).status).toBe(400);
    });

    it("sends the caller's notifications only, and a newly read one in the delta", async () => {
      const notification = (recipientId: string) =>
        ctx.prisma.notification.create({
          data: {
            organizationId: orgId,
            recipientId,
            type: 'task.assigned',
            title: 't',
            body: 'b',
          },
        });
      const own = await notification(W);
      await notification(W2);
      const first = await pull(W);
      expect(first.notifications.ids).toEqual([own.id]);
      await ctx.prisma.notification.update({
        where: { id: own.id },
        data: { createdAt: new Date(Date.now() - 10 * 60_000) },
      });
      const quiet = await pull(W, first.cursor);
      expect(quiet.notifications.upserts).toEqual([]);
      expect((await as(W).post(`/notifications/${own.id}/read`)).status).toBe(200);
      const read = await pull(W, first.cursor);
      expect(ids(read.notifications.upserts)).toEqual([own.id]);
    });

    it('is open to every role with a membership (policy sync.pull)', async () => {
      for (const userId of [W, SUP, tenant.admin.id]) {
        expect((await as(userId).get('/sync/pull')).status).toBe(200);
      }
      const noMember = await createUser(ctx.prisma, orgId);
      expect((await as(noMember.id).get('/sync/pull')).status).toBe(403);
      expect((await ctx.as(null).get('/sync/pull')).status).toBe(401);
    });
  });

  // Gaps filled by the test-writer (2026-10-27): real concurrency, late backdated logs with their
  // declared photos, the deny side of each rule, conflicts while offline, and offline metadata on
  // every kind of write.
  describe('retries and races', () => {
    it('two simultaneous requests with one Idempotency-Key change the task once, never a 5xx', async () => {
      const task = await assignedTask();
      const key = randomUUID();
      const send = () =>
        as(W).patch(
          `/tasks/${task.id}/status`,
          { status: 'in_progress', expectedVersion: 1 },
          { headers: offline({ key }) },
        );
      const responses = await Promise.all([send(), send(), send()]);
      for (const response of responses) {
        expect([200, 409]).toContain(response.status);
        if (response.status === 409) expect(response.body.code).toBe('request_in_progress');
      }
      expect(responses.some((response) => response.status === 200)).toBe(true);
      expect(await auditsOf('task.status_changed')).toHaveLength(1);
      const stored = await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect([stored.status, stored.version]).toEqual(['in_progress', 2]);
      // A retry after the race answers the stored result.
      const later = await send();
      expect([later.status, later.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
    });

    it('two simultaneous creates with one key and one clientId make one log and one outbox event', async () => {
      const key = randomUUID();
      const body = logBody();
      const responses = await Promise.all(
        [1, 2, 3].map(() => as(W).post('/work-logs', body, { headers: offline({ key }) })),
      );
      for (const response of responses) expect([200, 201, 409]).toContain(response.status);
      expect(await ctx.prisma.workLog.count()).toBe(1);
      expect(await auditsOf('work_log.created')).toHaveLength(1);
      expect(await ctx.prisma.outboxEvent.count({ where: { eventType: 'work_log.created' } })).toBe(
        1,
      );
    });

    it('two edits from two devices with the same expectedVersion: one wins, one gets version_conflict', async () => {
      const id = (await createLog(W)).body.id as string;
      const [one, two] = await Promise.all([
        as(W).patch(`/work-logs/${id}`, { text: 'phone', expectedVersion: 1 }),
        as(W).patch(`/work-logs/${id}`, { text: 'tablet', expectedVersion: 1 }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const loser = one.status === 409 ? one : two;
      expect(loser.body.code).toBe('version_conflict');
      const stored = await ctx.prisma.workLog.findUniqueOrThrow({ where: { id } });
      expect(stored.version).toBe(2);
      expect(await auditsOf('work_log.updated')).toHaveLength(1);
    });

    it('a resend of a status change whose answer was lost (no key) is a 200 that records nothing', async () => {
      const task = await assignedTask();
      const path = `/tasks/${task.id}/status`;
      const body = { status: 'done', expectedVersion: 1 };
      expect((await as(W).patch(path, body, { headers: offline() })).status).toBe(200);
      const resend = await as(W).patch(path, body, { headers: offline() });
      expect([resend.status, resend.body.version]).toEqual([200, 2]);
      expect(await auditsOf('task.status_changed')).toHaveLength(1);
    });
  });

  describe('conflicts while the worker was offline', () => {
    it('task cancelled meanwhile: 409 task_cancelled even with the old version', async () => {
      const task = await assignedTask();
      await as(SUP).patch(`/tasks/${task.id}/status`, {
        status: 'cancelled',
        reason: 'Not needed',
      });
      const mine = await as(W).patch(
        `/tasks/${task.id}/status`,
        { status: 'done', expectedVersion: 1 },
        { headers: offline() },
      );
      expect([mine.status, mine.body.code]).toEqual([409, 'task_cancelled']);
      const stored = await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(stored.status).toBe('cancelled');
    });

    it('task edited by the supervisor meanwhile (title): the queued status change gets version_conflict', async () => {
      const task = await assignedTask();
      await as(SUP).patch(`/tasks/${task.id}`, { title: 'New scope' });
      const stale = await as(W).patch(
        `/tasks/${task.id}/status`,
        { status: 'done', expectedVersion: 1 },
        { headers: offline() },
      );
      expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
      // Without a version (online screens) the same change passes.
      expect((await as(W).patch(`/tasks/${task.id}/status`, { status: 'done' })).status).toBe(200);
    });

    it('task reassigned meanwhile: 404 to the worker, 200 to the new assignee', async () => {
      const task = await assignedTask();
      await as(SUP).put(`/tasks/${task.id}/assignees`, { assigneeIds: [W2] });
      const gone = await as(W).patch(
        `/tasks/${task.id}/status`,
        { status: 'done', expectedVersion: 1 },
        { headers: offline() },
      );
      expect([gone.status, gone.body.code]).toEqual([404, 'not_found']);
      expect(
        (await as(W2).patch(`/tasks/${task.id}/status`, { status: 'in_progress' })).status,
      ).toBe(200);
    });

    it('edit of a log approved meanwhile, sent offline: 409 already_reviewed, nothing recorded', async () => {
      const id = (await createLog(W)).body.id as string;
      await as(SUP).patch(`/work-logs/${id}/status`, { status: 'approved' });
      const edit = await as(W).patch(
        `/work-logs/${id}`,
        { text: 'offline', expectedVersion: 1 },
        { headers: offline({ key: randomUUID() }) },
      );
      expect([edit.status, edit.body.code]).toEqual([409, 'already_reviewed']);
      expect(await auditsOf('work_log.updated')).toHaveLength(0);
    });
  });

  describe('late offline logs and their photos', () => {
    const photo = (clientId: string) => ({
      clientId,
      fileName: 'pump.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    });

    it('accepts a log sent 6 days after the work, then its declared photos 2 days later', async () => {
      const declared = randomUUID();
      const occurredAt = new Date(Date.now() - 6 * DAY).toISOString();
      const created = await createLog(
        W,
        { occurredAt, deviceCreatedAt: occurredAt, attachmentClientIds: [declared] },
        offline(),
      );
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ occurredAt, submittedOffline: true });
      ctx.clock.advance(2 * DAY); // the edit window is long gone; the work is 8 days old

      const bytes = await makeJpeg();
      const started = await as(W).post(`/work-logs/${created.body.id}/attachments`, {
        ...photo(declared),
        sizeBytes: bytes.byteLength,
      });
      expect(started.status).toBe(201);
      ctx.storage.uploadTo(started.body.upload.url, bytes);
      const completed = await as(W).post(`/attachments/${started.body.attachment.id}/complete`);
      expect([completed.status, completed.body.status]).toEqual([200, 'ready']);

      // An extra photo on the same old log is refused.
      const extra = await as(W).post(
        `/work-logs/${created.body.id}/attachments`,
        photo(randomUUID()),
      );
      expect([extra.status, extra.body.code]).toEqual([403, 'attachment_not_declared']);
    });

    it('refuses an undeclared photo on an old log created online too', async () => {
      const id = (await createLog(W)).body.id as string;
      ctx.clock.advance(2 * DAY);
      const refused = await as(W).post(`/work-logs/${id}/attachments`, photo(randomUUID()));
      expect([refused.status, refused.body.code]).toEqual([403, 'attachment_not_declared']);
    });

    it(`accepts up to ${MAX_DECLARED_ATTACHMENTS} declared photos and refuses more (400)`, async () => {
      const ids = (count: number) => Array.from({ length: count }, () => randomUUID());
      const tooMany = await createLog(
        W,
        { attachmentClientIds: ids(MAX_DECLARED_ATTACHMENTS + 1) },
        offline(),
      );
      expect(tooMany.status).toBe(400);
      expect(await ctx.prisma.workLog.count()).toBe(0);
      const max = await createLog(
        W,
        { attachmentClientIds: ids(MAX_DECLARED_ATTACHMENTS) },
        offline(),
      );
      expect(max.status).toBe(201);
      expect(max.body.declaredAttachmentClientIds).toHaveLength(MAX_DECLARED_ATTACHMENTS);
    });

    it('the 30-day grace: a declared photo just inside is accepted, just after is refused', async () => {
      const [inside, outside] = [randomUUID(), randomUUID()];
      const created = await createLog(W, { attachmentClientIds: [inside, outside] }, offline());
      const createdAt = Date.parse(created.body.createdAt as string);
      ctx.clock.freeze(new Date(createdAt + DECLARED_ATTACHMENT_GRACE_DAYS * DAY - 60_000));
      expect(
        (await as(W).post(`/work-logs/${created.body.id}/attachments`, photo(inside))).status,
      ).toBe(201);
      ctx.clock.freeze(new Date(createdAt + DECLARED_ATTACHMENT_GRACE_DAYS * DAY + 60_000));
      const late = await as(W).post(`/work-logs/${created.body.id}/attachments`, photo(outside));
      expect([late.status, late.body.code]).toEqual([403, 'edit_window_closed']);
    });

    it('a declared clientId serves only the author: a colleague and another site get 404', async () => {
      const declared = randomUUID();
      const created = await createLog(W, { attachmentClientIds: [declared] }, offline());
      ctx.clock.advance(2 * DAY);
      for (const userId of [W2, OTHER_SUP]) {
        const refused = await as(userId).post(
          `/work-logs/${created.body.id}/attachments`,
          photo(declared),
        );
        expect([userId, refused.status]).toEqual([userId, 404]);
      }
      expect(await ctx.prisma.attachment.count()).toBe(0);
      expect(
        (await as(W).post(`/work-logs/${created.body.id}/attachments`, photo(declared))).status,
      ).toBe(201);
    });
  });

  describe('occurredAt limits of an offline create', () => {
    it('follows the setting at its boundaries and keeps the 1-hour future margin', async () => {
      await as(tenant.admin.id).patch('/organization', { settings: { offlineMaxBackdateDays: 2 } });
      const send = (offsetMs: number) =>
        createLog(W, { occurredAt: new Date(Date.now() + offsetMs).toISOString() }, offline());
      expect((await send(-2 * DAY + 60_000)).status).toBe(201);
      const old = await send(-2 * DAY - 60_000);
      expect([old.status, old.body.code]).toEqual([422, 'occurred_at_out_of_range']);
      expect((await send(WORK_LOG_MAX_FUTURE_MS - 60_000)).status).toBe(201);
      const future = await send(WORK_LOG_MAX_FUTURE_MS + 60_000);
      expect([future.status, future.body.code]).toEqual([422, 'occurred_at_out_of_range']);
    });

    it('an offline edit moving occurredAt past the limit is refused and changes nothing', async () => {
      const id = (await createLog(W, {}, offline())).body.id as string;
      const moved = await as(W).patch(
        `/work-logs/${id}`,
        { occurredAt: new Date(Date.now() - 8 * DAY).toISOString(), expectedVersion: 1 },
        { headers: offline() },
      );
      expect([moved.status, moved.body.code]).toEqual([422, 'occurred_at_out_of_range']);
      expect((await ctx.prisma.workLog.findUniqueOrThrow({ where: { id } })).version).toBe(1);
    });
  });

  describe('audit and outbox of offline writes', () => {
    it('marks an offline edit, log status change and photo start; the outbox is still written', async () => {
      const declared = randomUUID();
      const id = (await createLog(W, { attachmentClientIds: [declared] }, offline())).body
        .id as string;
      const deviceTime = new Date(Date.now() - 2 * HOUR);
      const headers = offline({ deviceTime });
      expect(
        (await as(W).patch(`/work-logs/${id}`, { text: 'more', expectedVersion: 1 }, { headers }))
          .status,
      ).toBe(200);
      expect(
        (await as(W).patch(`/work-logs/${id}/status`, { status: 'draft' }, { headers })).status,
      ).toBe(200);
      expect(
        (
          await as(W).post(
            `/work-logs/${id}/attachments`,
            { clientId: declared, fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 10 },
            { headers },
          )
        ).status,
      ).toBe(201);

      const audits = await ctx.prisma.auditEvent.findMany({ orderBy: { occurredAt: 'asc' } });
      expect(audits.length).toBeGreaterThanOrEqual(4);
      for (const audit of audits) {
        const metadata = auditMetadataSchema.parse(audit.metadata);
        expect(metadata.via).toBe('offline_sync');
      }
      const edit = audits.find((audit) => audit.action === 'work_log.updated');
      const metadata = auditMetadataSchema.parse(edit?.metadata);
      expect(metadata.deviceTime).toBe(deviceTime.toISOString());
      expect(Math.abs((metadata.clockSkewSeconds ?? 0) + 7200)).toBeLessThanOrEqual(5);

      const events = await ctx.prisma.outboxEvent.findMany({ select: { eventType: true } });
      expect(events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(['work_log.created', 'work_log.updated']),
      );
      // The outbox payload is the business event, without the request's sync metadata.
      expect(events.length).toBeGreaterThanOrEqual(3);
    });

    it('online edits and status changes have no metadata', async () => {
      const id = (await createLog(W)).body.id as string;
      await as(W).patch(`/work-logs/${id}`, { text: 'online' });
      const task = await assignedTask();
      await as(W).patch(`/tasks/${task.id}/status`, { status: 'done' });
      const audits = await ctx.prisma.auditEvent.findMany();
      expect(audits.length).toBeGreaterThanOrEqual(3);
      expect(audits.every((audit) => audit.metadata === null)).toBe(true);
    });
  });

  describe('pull pruning of archived and out-of-scope places', () => {
    it('removes an archived site, an archived task and a site whose membership ended', async () => {
      const task = await assignedTask();
      const extraSite = await createSite(ctx.prisma, orgId);
      const membership = await createMembership(ctx.prisma, orgId, W, 'worker', {
        siteIds: [extraSite.id],
      });
      const first = (await as(W).get('/sync/pull')).body as {
        cursor: string;
        sites: { ids: string[] };
        tasks: { ids: string[] };
      };
      expect(first.sites.ids).toEqual(expect.arrayContaining([siteId, extraSite.id]));
      expect(first.tasks.ids).toEqual([task.id]);

      await as(SUP).post(`/tasks/${task.id}/archive`);
      const afterArchive = (await as(W).get('/sync/pull', { cursor: first.cursor })).body as {
        tasks: { ids: string[] };
      };
      expect(afterArchive.tasks.ids).toEqual([]);

      await ctx.prisma.membership.update({
        where: { id: membership.id },
        data: { archivedAt: new Date() },
      });
      await ctx.prisma.site.update({ where: { id: siteId }, data: { archivedAt: new Date() } });
      const after = (await as(W).get('/sync/pull', { cursor: first.cursor })).body as {
        full: boolean;
        sites: { ids: string[] };
      };
      expect(after.full).toBe(true);
      expect(after.sites.ids).not.toContain(extraSite.id);
      expect(after.sites.ids).not.toContain(siteId);
    });
  });

  it('keeps the fixture times inside the sync window', () => {
    expect(Date.now() - at().getTime()).toBeLessThan(7 * DAY);
  });
});
