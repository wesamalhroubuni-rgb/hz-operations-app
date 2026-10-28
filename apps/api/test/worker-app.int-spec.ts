import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  customFieldDefinitionsSchema,
  customFieldFormToValues,
  initialCustomFieldValues,
  parseFormNumber,
  reconcileCustomFieldValues,
  splitErrorDetails,
  type CustomFieldDefinition,
  type CustomFieldDefinitionInput,
  type CustomFieldFormValues,
  type LogType,
  type Task,
  type TaskStatus,
  type WorkLog,
} from '@ops/shared';
import {
  at,
  createLogType,
  createMembership,
  createSite,
  createTask,
  createTenant,
  createUser,
  eventCounts,
  type Tenant,
} from './support/factories';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

// The worker app's rules checked end to end against the API (Phase 4):
// - the dynamic custom-field form of @ops/shared: what the phone accepts is exactly what the
//   API stores, and what the API refuses lands on the right field;
// - the worker's task-status moves and the work-log edit window: the PHONE'S OWN LOGIC
//   (apps/mobile/src/logic, loaded below) is driven through the same cases as the API, and its
//   decision must equal the API's answer;
// - the review fields of a work log.
// Example values only.

const HOUR = 3_600_000;

/** The phone's pure logic, loaded from the mobile app's sources (no React Native in them). */
interface PhoneWorkLogRules {
  canEditWorkLog(
    log: Pick<WorkLog, 'authorId' | 'status' | 'createdAt' | 'archivedAt'>,
    userId: string,
    now: Date,
    editWindowHours: number,
  ): boolean;
  canResubmitWorkLog(
    log: Pick<WorkLog, 'authorId' | 'status' | 'createdAt' | 'archivedAt'>,
    userId: string,
    now: Date,
    editWindowHours: number,
  ): boolean;
  canSubmitDraft(
    log: Pick<WorkLog, 'authorId' | 'status' | 'createdAt' | 'archivedAt'>,
    userId: string,
    now: Date,
    editWindowHours: number,
  ): boolean;
}
interface PhoneTaskRules {
  assigneeStatusActions(
    task: Pick<Task, 'status' | 'assigneeIds' | 'archivedAt'>,
    userId: string,
  ): TaskStatus[];
  statusNeedsReason(status: TaskStatus): boolean;
}
interface PhoneLogFormValues {
  clientId: string;
  logTypeId: string | null;
  customFields: CustomFieldFormValues;
  text: string;
  taskId: string | null;
  siteId: string | null;
  teamId: string | null;
  occurredAt: string | null;
  location: null | { latitude: number; longitude: number; accuracy?: number | null };
}
interface PhoneLogForm {
  logFormValuesFromLog(log: WorkLog, logType: LogType | null): PhoneLogFormValues;
  buildUpdateBody(
    values: PhoneLogFormValues,
    original: WorkLog,
    logType: LogType | null,
    photoCount: number,
    now: Date,
  ): { ok: true; body: Record<string, unknown> | null } | { ok: false; errors: unknown };
}
const mobileLogic = (name: string) => resolve(__dirname, '../../mobile/src/logic', `${name}.ts`);
const phoneWorkLogs = jest.requireActual<PhoneWorkLogRules>(mobileLogic('workLogs'));
const phoneTasks = jest.requireActual<PhoneTaskRules>(mobileLogic('tasks'));
const phoneLogForm = jest.requireActual<PhoneLogForm>(mobileLogic('logForm'));

/** A log type with every field type, a select with more than four options, required and optional. */
const EVERY_TYPE: CustomFieldDefinitionInput[] = [
  { key: 'area', label: 'Area', type: 'text', required: true },
  { key: 'remark', label: 'Remark', type: 'text' },
  { key: 'quantity', label: 'Quantity', type: 'number', required: true },
  { key: 'temperature', label: 'Temperature', type: 'number' },
  { key: 'safe', label: 'Safe', type: 'boolean', required: true },
  { key: 'photo_taken', label: 'Photo taken', type: 'boolean' },
  { key: 'result', label: 'Result', type: 'select', options: ['ok', 'defect'], required: true },
  {
    key: 'weather',
    label: 'Weather',
    type: 'select',
    options: ['sun', 'cloud', 'rain', 'snow', 'wind', 'fog'],
  },
  { key: 'next_check', label: 'Next check', type: 'date', required: true },
  { key: 'installed', label: 'Installed', type: 'date' },
];

describe('worker app rules against the API', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let siteId: string;
  let workerId: string;
  let supervisorId: string;
  let worker: ApiCaller;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    const orgId = tenant.organization.id;
    siteId = (await createSite(ctx.prisma, orgId)).id;
    workerId = (await createUser(ctx.prisma, orgId)).id;
    await createMembership(ctx.prisma, orgId, workerId, 'worker', { siteIds: [siteId] });
    supervisorId = (await createUser(ctx.prisma, orgId)).id;
    await createMembership(ctx.prisma, orgId, supervisorId, 'supervisor', { siteIds: [siteId] });
    worker = ctx.as(workerId);
  });
  afterAll(() => ctx.close());

  const orgId = () => tenant.organization.id;

  /** The log type as the phone receives it from the API. */
  async function logTypeFromApi(fields: CustomFieldDefinitionInput[]): Promise<LogType> {
    const row = await createLogType(ctx.prisma, orgId(), { fields });
    const response = await worker.get(`/log-types/${row.id}`);
    expect(response.status).toBe(200);
    return response.body as LogType;
  }

  const createBody = (logTypeId: string, customFields: unknown) => ({
    clientId: randomUUID(),
    occurredAt: at().toISOString(),
    logTypeId,
    siteId,
    customFields,
  });

  describe('custom-field form round trip (form -> values -> API)', () => {
    it('a form filled the way people type on a phone is stored exactly as converted, for every type', async () => {
      const logType = await logTypeFromApi(EVERY_TYPE);
      const form: CustomFieldFormValues = {
        ...initialCustomFieldValues(logType.fields),
        area: '  Pump room 2 ',
        remark: '',
        quantity: '12,5',
        temperature: ' -3.25 ',
        safe: false, // an explicit "no" on a required yes/no is an answer
        photo_taken: null, // unanswered optional yes/no
        result: 'defect',
        weather: 'fog',
        next_check: '2026-11-01',
        installed: '',
      };

      const converted = customFieldFormToValues(logType.fields, form);
      expect(converted).toEqual({
        ok: true,
        values: {
          area: '  Pump room 2 ',
          quantity: 12.5,
          temperature: -3.25,
          safe: false,
          result: 'defect',
          weather: 'fog',
          next_check: '2026-11-01',
        },
      });
      if (!converted.ok) return;

      const created = await worker.post('/work-logs', createBody(logType.id, converted.values));
      expect(created.status).toBe(201);
      expect(created.body.customFields).toEqual(converted.values);
      expect(created.body.logTypeVersion).toBe(logType.version);
      const stored = await worker.get(`/work-logs/${created.body.id}`);
      expect(stored.body.customFields).toEqual(converted.values);

      // Opening the log again for editing shows what was typed (as the API stored it).
      expect(initialCustomFieldValues(logType.fields, stored.body.customFields)).toEqual({
        area: '  Pump room 2 ',
        remark: '',
        quantity: '12.5',
        temperature: '-3.25',
        safe: false,
        photo_taken: null,
        result: 'defect',
        weather: 'fog',
        next_check: '2026-11-01',
        installed: '',
      });
    });

    // Each form is judged by the phone first; sent anyway, the API must give the same verdict,
    // with its refusals on the same fields.
    const complete: CustomFieldFormValues = {
      area: 'Hall',
      quantity: '1',
      safe: true,
      result: 'ok',
      next_check: '2026-11-01',
    };
    it.each<[string, CustomFieldFormValues]>([
      ['complete', complete],
      ['a comma decimal', { ...complete, quantity: '0,75' }],
      ['an empty required number', { ...complete, quantity: '' }],
      ['a blank required text', { ...complete, area: '   ' }],
      ['an unanswered required yes/no', { ...complete, safe: null }],
      ['a choice that is not an option', { ...complete, weather: 'hail' }],
      ['a choice of another field', { ...complete, result: 'sun' }],
      ['an impossible date', { ...complete, next_check: '2026-02-30' }],
      [
        'a datetime with an offset in a date field',
        { ...complete, installed: '2026-10-01T08:00:00+03:00' },
      ],
      ['a datetime without an offset', { ...complete, installed: '2026-10-01T08:00:00' }],
      ['nothing at all', {}],
    ])('%s: the phone and the API agree', async (_name, form) => {
      const logType = await logTypeFromApi(EVERY_TYPE);
      const phone = customFieldFormToValues(logType.fields, form);
      // What the phone would send if it did not check: the raw form, numbers converted where
      // they can be read, empty inputs left out.
      const numberKeys = new Set(
        logType.fields.filter((field) => field.type === 'number').map((field) => field.key),
      );
      const sent = phone.ok
        ? phone.values
        : Object.fromEntries(
            Object.entries(form)
              .filter(([, value]) => value !== null && value !== '')
              .map(([key, value]) => [
                key,
                numberKeys.has(key) && typeof value === 'string'
                  ? (parseFormNumber(value) ?? value)
                  : value,
              ]),
          );
      const response = await worker.post('/work-logs', createBody(logType.id, sent));

      if (phone.ok) {
        expect(response.status).toBe(201);
        expect(response.body.customFields).toEqual(phone.values);
      } else {
        expect(response.status).toBe(400);
        const server = splitErrorDetails(response.body.details as Json[]).customFields;
        expect(Object.keys(server).sort()).toEqual(Object.keys(phone.errors).sort());
        for (const [key, error] of Object.entries(phone.errors)) {
          // A number the phone could not read is sent as text: the API says "must be a number".
          expect([key, server[key]?.code]).toEqual([key, error.code]);
        }
      }
    });

    it('rejects Infinity and NaN typed into a number field on the phone; the API never sees them', async () => {
      const logType = await logTypeFromApi(EVERY_TYPE);
      for (const typed of ['Infinity', 'NaN', '1e400', '12 pcs']) {
        const result = customFieldFormToValues(logType.fields, { ...complete, quantity: typed });
        expect([typed, result.ok === false && result.errors.quantity?.code]).toEqual([
          typed,
          'number',
        ]);
      }
      // The API refuses the JSON values a broken client could send instead.
      const valid = customFieldFormToValues(logType.fields, complete);
      if (!valid.ok) throw new Error('fixture');
      for (const value of ['12', true, null, 'Infinity']) {
        const response = await worker.post(
          '/work-logs',
          createBody(logType.id, { ...valid.values, quantity: value }),
        );
        expect([value, response.status]).toEqual([value, 400]);
        expect(response.body.details).toEqual([
          {
            path: 'customFields.quantity',
            message: value === null ? 'is required' : 'must be a number',
          },
        ]);
      }
    });

    it('after the log type changed, a reconciled draft is judged the same by the phone and the API', async () => {
      const row = await createLogType(ctx.prisma, orgId(), { fields: EVERY_TYPE });
      const draft: CustomFieldFormValues = {
        ...complete,
        remark: 'old remark',
        weather: 'fog',
        temperature: '20',
      };
      // The admin changes the type meanwhile: `remark` removed, `temperature` becomes a
      // yes/no, `weather` loses "fog", a new required field appears.
      const changed = customFieldDefinitionsSchema.parse([
        ...EVERY_TYPE.filter((field) => !['remark', 'temperature', 'weather'].includes(field.key)),
        { key: 'temperature', label: 'Too hot', type: 'boolean' },
        { key: 'weather', label: 'Weather', type: 'select', options: ['sun', 'rain'] },
        { key: 'shift', label: 'Shift', type: 'select', options: ['day', 'night'], required: true },
      ]);
      const patched = await ctx
        .as(tenant.admin.id)
        .patch(`/log-types/${row.id}`, { fields: changed });
      expect(patched.status).toBe(200);
      const fields = (await worker.get(`/log-types/${row.id}`)).body
        .fields as CustomFieldDefinition[];

      const reconciled = reconcileCustomFieldValues(fields, draft);
      expect(reconciled).not.toHaveProperty('remark');
      expect(reconciled.temperature).toBeNull(); // a number's text is no yes/no answer
      expect(reconciled.shift).toBe('');
      const phone = customFieldFormToValues(fields, reconciled);
      expect(phone.ok === false && Object.keys(phone.errors).sort()).toEqual(['shift', 'weather']);

      // Sent as reconciled (without checking), the API refuses the same two fields.
      const raw = { ...complete, quantity: 1, weather: 'fog' };
      const refused = await worker.post('/work-logs', createBody(row.id, raw));
      expect(refused.status).toBe(400);
      expect(Object.keys(splitErrorDetails(refused.body.details).customFields).sort()).toEqual([
        'shift',
        'weather',
      ]);
      // The removed field is refused by the API if an old client still sends it.
      const stale = await worker.post(
        '/work-logs',
        createBody(row.id, { ...raw, weather: 'sun', shift: 'day', remark: 'old remark' }),
      );
      expect(stale.status).toBe(400);
      expect(splitErrorDetails(stale.body.details).customFields).toEqual({
        remark: { code: 'unknownField', message: 'is not a field of this log type' },
      });

      // Fixed on the phone, it is accepted with the new version.
      const fixed = customFieldFormToValues(fields, {
        ...reconciled,
        weather: 'sun',
        shift: 'night',
      });
      expect(fixed.ok).toBe(true);
      if (!fixed.ok) return;
      const created = await worker.post('/work-logs', createBody(row.id, fixed.values));
      expect(created.status).toBe(201);
      expect(created.body.logTypeVersion).toBe(patched.body.version);
    });

    // BUG (reported): editing only the text of a log whose log type has since been ARCHIVED.
    // The phone lists active log types only, so the edit form gets no definition
    // (`logType = null`) and `buildUpdateBody` then sends `customFields: {}`: the API re-validates
    // against the type and refuses the required fields the phone cannot show (400), or would
    // silently wipe optional values.
    it('editing only the text of a log of an archived log type keeps its custom fields', async () => {
      const logType = await logTypeFromApi(EVERY_TYPE);
      const values = customFieldFormToValues(logType.fields, complete);
      if (!values.ok) throw new Error('fixture');
      const created = await worker.post('/work-logs', createBody(logType.id, values.values));
      expect(created.status).toBe(201);
      await ctx.prisma.logType.update({
        where: { id: logType.id },
        data: { archivedAt: new Date() },
      });

      const log = created.body as WorkLog;
      const form = phoneLogForm.logFormValuesFromLog(log, null);
      const built = phoneLogForm.buildUpdateBody(
        { ...form, text: 'Corrected note' },
        log,
        null,
        0,
        new Date(),
      );
      expect(built.ok).toBe(true);
      if (!built.ok || built.body === null) return;
      const updated = await worker.patch(`/work-logs/${log.id}`, built.body);

      expect(updated.status).toBe(200);
      expect(updated.body.customFields).toEqual(values.values);
    });
  });

  describe('worker task status: the phone offers exactly what the API allows', () => {
    const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];

    async function assignedTask(status: TaskStatus, assigneeIds = [workerId]) {
      return createTask(ctx.prisma, orgId(), tenant.admin.id, {
        status,
        siteId,
        assigneeIds,
        ...(status === 'blocked' ? { statusReason: 'Earlier reason' } : {}),
        ...(status === 'done' ? { completedAt: at() } : {}),
      });
    }

    it.each(STATUSES)('from %s', async (from) => {
      const offeredButRefused: string[] = [];
      const allowedButNotOffered: string[] = [];
      for (const to of STATUSES) {
        const task = await assignedTask(from);
        const asSeen = (await worker.get(`/tasks/${task.id}`)).body as Task;
        const offered = phoneTasks.assigneeStatusActions(asSeen, workerId).includes(to);
        const body = phoneTasks.statusNeedsReason(to)
          ? { status: to, reason: 'No ladder' }
          : { status: to };
        const response = await worker.patch(`/tasks/${task.id}/status`, body);
        // Blocked again with a new reason is a real change: it updates the reason.
        const changed =
          response.status === 200 &&
          response.body.status === to &&
          (from !== to || (to === 'blocked' && response.body.statusReason === 'No ladder'));
        if (offered && !changed) offeredButRefused.push(`${to}:${response.status}`);
        if (!offered && changed) allowedButNotOffered.push(to);
        if (to === 'cancelled' || from === 'cancelled') {
          // Cancelling, and anything on a cancelled task, is for whoever manages it: 403 for
          // cancelling, 409 `task_cancelled` on a cancelled task (ADR-0008). Asking for the
          // status the task already has is a no-op (200).
          const expected = from === to ? 200 : from === 'cancelled' ? 409 : 403;
          expect([to, response.status]).toEqual([to, expected]);
        }
      }
      expect(offeredButRefused).toEqual([]);
      // The one difference: the API lets an assignee block a finished task; the phone does not
      // offer it (a finished task is reopened first). Reported as a divergence.
      expect(allowedButNotOffered).toEqual(from === 'done' ? ['blocked'] : []);
    });

    it('blocked needs a reason (400), stores it, a new reason on the same status updates it, a change without one clears it', async () => {
      const task = await assignedTask('todo');
      const path = `/tasks/${task.id}/status`;
      expect((await worker.patch(path, { status: 'blocked' })).status).toBe(400);
      expect((await worker.patch(path, { status: 'blocked', reason: '   ' })).status).toBe(400);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });

      const blocked = await worker.patch(path, { status: 'blocked', reason: ' No ladder ' });
      expect(blocked.status).toBe(200);
      expect(blocked.body).toMatchObject({ status: 'blocked', statusReason: 'No ladder' });
      const same = await worker.patch(path, { status: 'blocked', reason: 'No ladder' });
      expect(same.status).toBe(200);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });

      const updated = await worker.patch(path, { status: 'blocked', reason: 'Ladder broken' });
      expect(updated.body.statusReason).toBe('Ladder broken');
      const events = await ctx.prisma.outboxEvent.findMany({ orderBy: { sequence: 'asc' } });
      expect(
        events.map((event) => [
          event.eventType,
          (event.payload as Json).from,
          (event.payload as Json).to,
          (event.payload as Json).reason,
        ]),
      ).toEqual([
        ['task.status_changed', 'todo', 'blocked', 'No ladder'],
        ['task.status_changed', 'blocked', 'blocked', 'Ladder broken'],
      ]);
      expect(events.every((event) => event.actorId === workerId)).toBe(true);

      const resumed = await worker.patch(path, { status: 'in_progress' });
      expect(resumed.body).toMatchObject({ status: 'in_progress', statusReason: null });
      const done = await worker.patch(path, { status: 'done' });
      expect(done.body.completedAt).not.toBeNull();
      expect((await worker.patch(path, { status: 'todo' })).body.completedAt).toBeNull();
    });

    it('a worker who is not assigned gets 404 (cannot see it); a co-assignee may move it', async () => {
      const colleague = (await createUser(ctx.prisma, orgId())).id;
      await createMembership(ctx.prisma, orgId(), colleague, 'worker', { siteIds: [siteId] });
      const notMine = await assignedTask('todo', [colleague]);
      const response = await worker.patch(`/tasks/${notMine.id}/status`, { status: 'done' });
      expect(response.status).toBe(404);
      expect((await ctx.prisma.task.findUniqueOrThrow({ where: { id: notMine.id } })).status).toBe(
        'todo',
      );

      const shared = await assignedTask('todo', [colleague, workerId]);
      expect(
        (await worker.patch(`/tasks/${shared.id}/status`, { status: 'in_progress' })).status,
      ).toBe(200);
    });

    it('a supervisor who sees the task only through an assignee (not placed in their scope) gets 403', async () => {
      const otherSite = await createSite(ctx.prisma, orgId());
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        siteId: otherSite.id,
        assigneeIds: [workerId],
      });
      const response = await ctx
        .as(supervisorId)
        .patch(`/tasks/${task.id}/status`, { status: 'done' });
      expect(response.status).toBe(403);
    });

    it('an archived task offers nothing on the phone and answers 409', async () => {
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        siteId,
        assigneeIds: [workerId],
        archivedAt: new Date(),
      });
      const seen = (await worker.get(`/tasks/${task.id}`)).body as Task;
      expect(phoneTasks.assigneeStatusActions(seen, workerId)).toEqual([]);
      expect((await worker.patch(`/tasks/${task.id}/status`, { status: 'done' })).status).toBe(409);
    });
  });

  describe('edit window from the phone: the phone decides like the API', () => {
    type Case = {
      name: string;
      status: WorkLog['status'];
      /** Hours after createdAt, plus milliseconds. */
      after: [number, number];
      windowHours?: number;
      archived?: boolean;
      /** Act as the supervisor instead of the author. */
      bySupervisor?: boolean;
    };
    const cases: Case[] = [
      { name: 'inside the window', status: 'submitted', after: [1, 0] },
      { name: 'exactly at the edge (inclusive)', status: 'submitted', after: [24, 0] },
      { name: '1 ms after the window', status: 'submitted', after: [24, 1] },
      { name: 'an approved log inside the window', status: 'approved', after: [1, 0] },
      { name: 'a rejected log inside the window', status: 'rejected', after: [23, 0] },
      { name: 'a rejected log after the window', status: 'rejected', after: [25, 0] },
      { name: 'a draft inside the window', status: 'draft', after: [2, 0] },
      {
        name: 'an archived log inside the window',
        status: 'submitted',
        after: [1, 0],
        archived: true,
      },
      {
        name: 'a 2-hour organization window, at the edge',
        status: 'submitted',
        after: [2, 0],
        windowHours: 2,
      },
      {
        name: 'a 2-hour organization window, just after',
        status: 'submitted',
        after: [2, 1],
        windowHours: 2,
      },
      {
        name: 'a supervisor on the worker’s log (not the author)',
        status: 'submitted',
        after: [1, 0],
        bySupervisor: true,
      },
    ];

    it.each(cases)('$name', async ({ status, after, windowHours, archived, bySupervisor }) => {
      if (windowHours !== undefined) {
        const settings = await ctx
          .as(tenant.admin.id)
          .patch('/organization', { settings: { workLogEditWindowHours: windowHours } });
        expect(settings.status).toBe(200);
      }
      const createdAt = new Date(Date.now() - 60_000);
      const row = await ctx.prisma.workLog.create({
        data: {
          organizationId: orgId(),
          authorId: workerId,
          clientId: randomUUID(),
          occurredAt: at(),
          siteId,
          status,
          createdAt,
          archivedAt: archived ? new Date() : null,
        },
      });
      ctx.clock.freeze(new Date(createdAt.getTime() + after[0] * HOUR + after[1]));
      const actorId = bySupervisor ? supervisorId : workerId;
      const api = ctx.as(actorId);
      const log = (await api.get(`/work-logs/${row.id}`)).body as WorkLog;
      const window = (await api.get('/organization')).body.workLogEditWindowHours as number;
      const now = ctx.clock.now();

      const phoneEdit = phoneWorkLogs.canEditWorkLog(log, actorId, now, window);
      const edit = await api.patch(`/work-logs/${row.id}`, { text: 'Edited on the phone' });
      expect({ phone: phoneEdit, api: edit.status }).toEqual({
        phone: edit.status === 200,
        api: edit.status,
      });

      // The status moves the phone offers to the author, against the API.
      const resubmit = phoneWorkLogs.canResubmitWorkLog(log, actorId, now, window);
      const submitDraft = phoneWorkLogs.canSubmitDraft(log, actorId, now, window);
      if (status === 'rejected' || status === 'draft') {
        const moved = await api.patch(`/work-logs/${row.id}/status`, { status: 'submitted' });
        expect({
          phone: status === 'rejected' ? resubmit : submitDraft,
          api: moved.status,
        }).toEqual({
          phone: moved.status === 200,
          api: moved.status,
        });
        if (moved.status === 200) {
          expect(moved.body.review).toBeNull();
        }
      } else {
        expect([resubmit, submitDraft]).toEqual([false, false]);
      }
    });
  });

  describe('review fields', () => {
    async function submittedLog() {
      return ctx.prisma.workLog.create({
        data: {
          organizationId: orgId(),
          authorId: workerId,
          clientId: randomUUID(),
          occurredAt: at(),
          siteId,
          status: 'submitted',
        },
      });
    }

    it('note: required to reject, optional to approve, refused for other statuses, trimmed, limited', async () => {
      const log = await submittedLog();
      const path = `/work-logs/${log.id}/status`;
      const reviewer = ctx.as(supervisorId);
      for (const body of [
        { status: 'rejected' },
        { status: 'rejected', note: '   ' },
        { status: 'rejected', note: 'x'.repeat(2001) },
        { status: 'submitted', note: 'Please redo' },
        { status: 'draft', note: 'x' },
      ]) {
        expect([body, (await reviewer.patch(path, body)).status]).toEqual([body, 400]);
      }
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });

      const approved = await reviewer.patch(path, { status: 'approved', note: '  Good photos  ' });
      expect(approved.status).toBe(200);
      expect(approved.body.review).toMatchObject({
        reviewedById: supervisorId,
        note: 'Good photos',
      });
    });

    it('the author sees the rejection note, resubmits inside the window, and the review is cleared', async () => {
      const log = await submittedLog();
      const rejected = await ctx.as(supervisorId).patch(`/work-logs/${log.id}/status`, {
        status: 'rejected',
        note: 'Photo of the meter missing',
      });
      expect(rejected.status).toBe(200);

      const seen = await worker.get(`/work-logs/${log.id}`);
      expect(seen.body.status).toBe('rejected');
      expect(seen.body.review).toMatchObject({
        reviewedById: supervisorId,
        note: 'Photo of the meter missing',
      });
      expect(Date.parse(seen.body.review.reviewedAt)).not.toBeNaN();

      expect(
        (await worker.patch(`/work-logs/${log.id}`, { text: 'Added the meter photo' })).status,
      ).toBe(200);
      const resubmitted = await worker.patch(`/work-logs/${log.id}/status`, {
        status: 'submitted',
      });
      expect(resubmitted.status).toBe(200);
      expect(resubmitted.body.review).toBeNull();
      const event = await ctx.prisma.outboxEvent.findFirstOrThrow({
        where: { eventType: 'work_log.status_changed', actorId: workerId },
      });
      expect(event.payload).toMatchObject({
        from: 'rejected',
        to: 'submitted',
        note: null,
        reviewedById: null,
      });

      // The author can neither approve nor reject their own log.
      expect(
        (await worker.patch(`/work-logs/${log.id}/status`, { status: 'approved' })).status,
      ).toBe(403);
    });

    // Doubtful (reported): rejecting an already rejected log with a NEW note answers 200 but keeps
    // the old note (same status is a no-op), while tasks update the reason on the same status.
    it('re-rejecting with another note updates the note; the same note changes nothing', async () => {
      const log = await submittedLog();
      const reviewer = ctx.as(supervisorId);
      await reviewer.patch(`/work-logs/${log.id}/status`, {
        status: 'rejected',
        note: 'First note',
      });
      const again = await reviewer.patch(`/work-logs/${log.id}/status`, {
        status: 'rejected',
        note: 'Second note',
      });
      expect(again.status).toBe(200);
      expect(again.body.review.note).toBe('Second note');
      const events = await ctx.prisma.outboxEvent.count({
        where: { eventType: 'work_log.status_changed', aggregateId: log.id },
      });
      const same = await reviewer.patch(`/work-logs/${log.id}/status`, {
        status: 'rejected',
        note: 'Second note',
      });
      expect(same.status).toBe(200);
      expect(
        await ctx.prisma.outboxEvent.count({
          where: { eventType: 'work_log.status_changed', aggregateId: log.id },
        }),
      ).toBe(events);
    });
  });
});
