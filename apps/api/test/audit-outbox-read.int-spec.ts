import { randomUUID } from 'node:crypto';
import {
  apiErrorSchema,
  auditEventListSchema,
  auditEventSchema,
  outboxEventListSchema,
  outboxEventSchema,
} from '@ops/shared';
import {
  at,
  atWithOffset,
  createTenant,
  eventCounts,
  unknownId,
  type Tenant,
} from './support/factories';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

// The read-only /audit-events and /outbox-events endpoints. Events are inserted directly, with
// fixed times, so the filters can be checked exactly (INSERT is allowed on the audit log).

describe('audit and outbox read endpoints', () => {
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

  const TASK_1 = '0190f3a2-7c1e-7000-8000-00000000a001';
  const TASK_2 = '0190f3a2-7c1e-7000-8000-00000000a002';
  const SITE_1 = '0190f3a2-7c1e-7000-8000-00000000b001';
  const ACTOR_2 = '0190f3a2-7c1e-7000-8000-00000000c002';

  interface EventSeed {
    name: string;
    entity: string;
    id: string;
    minute: number;
    correlationId: string;
    actorId?: string | null;
    organizationId?: string | null;
  }

  /** The same six events in both logs, at at(n) minutes. */
  const EVENTS: EventSeed[] = [
    { name: 'task.created', entity: 'task', id: TASK_1, minute: 0, correlationId: 'corr-1' },
    {
      name: 'task.status_changed',
      entity: 'task',
      id: TASK_1,
      minute: 10,
      correlationId: 'corr-2',
    },
    { name: 'site.created', entity: 'site', id: SITE_1, minute: 20, correlationId: 'corr-3' },
    {
      name: 'task.created',
      entity: 'task',
      id: TASK_2,
      minute: 30,
      correlationId: 'corr-4',
      actorId: ACTOR_2,
    },
    {
      name: 'task.archived',
      entity: 'task',
      id: TASK_2,
      minute: 40,
      correlationId: 'corr-4',
      actorId: ACTOR_2,
    },
    {
      name: 'task_list.created',
      entity: 'task_list',
      id: 'list-1',
      minute: 50,
      correlationId: 'corr-5',
    },
  ];

  async function seedEvents(): Promise<void> {
    const rows = [
      ...EVENTS,
      // Noise that must never show up for the caller: another organization, and no organization.
      {
        name: 'task.created',
        entity: 'task',
        id: TASK_1,
        minute: 5,
        correlationId: 'corr-1',
        organizationId: other.organization.id,
      },
      {
        name: 'task.created',
        entity: 'task',
        id: TASK_1,
        minute: 6,
        correlationId: 'corr-1',
        organizationId: null,
        actorId: null,
      },
    ] satisfies EventSeed[];
    for (const row of rows) {
      const organizationId = row.organizationId === undefined ? orgId() : row.organizationId;
      const actorId = row.actorId === undefined ? tenant.admin.id : row.actorId;
      await ctx.prisma.auditEvent.create({
        data: {
          organizationId,
          actorType: actorId ? 'user' : 'system',
          actorId,
          action: row.name,
          entityType: row.entity,
          entityId: row.id,
          after: { id: row.id },
          correlationId: row.correlationId,
          occurredAt: at(row.minute),
        },
      });
      await ctx.prisma.outboxEvent.create({
        data: {
          organizationId,
          eventType: row.name,
          aggregateType: row.entity,
          aggregateId: row.id,
          payload: { id: row.id },
          actorId,
          correlationId: row.correlationId,
          occurredAt: at(row.minute),
        },
      });
    }
  }

  const minutesOf = (response: { body: Json }) =>
    (response.body.items as Json[]).map(
      (item) => (new Date(item.occurredAt).getTime() - at().getTime()) / 60_000,
    );

  describe('GET /audit-events', () => {
    it('returns the pagination envelope, newest first, in the wire shape', async () => {
      await seedEvents();
      const response = await api.get('/audit-events');
      expect(response.status).toBe(200);
      expect(auditEventListSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({ page: 1, pageSize: 25, total: 6 });
      expect(minutesOf(response)).toEqual([50, 40, 30, 20, 10, 0]);
      expect(response.body.items[5]).toEqual({
        id: expect.any(String),
        organizationId: orgId(),
        actorType: 'user',
        actorId: tenant.admin.id,
        action: 'task.created',
        entityType: 'task',
        entityId: TASK_1,
        before: null,
        after: { id: TASK_1 },
        changes: null,
        correlationId: 'corr-1',
        metadata: null,
        occurredAt: at(0).toISOString(),
      });
    });

    it('filters by entity type and entity id', async () => {
      await seedEvents();
      expect(minutesOf(await api.get('/audit-events', { entityType: 'task' }))).toEqual([
        40, 30, 10, 0,
      ]);
      expect(minutesOf(await api.get('/audit-events', { entityType: 'site' }))).toEqual([20]);
      expect(
        minutesOf(await api.get('/audit-events', { entityType: 'task', entityId: TASK_1 })),
      ).toEqual([10, 0]);
      expect(minutesOf(await api.get('/audit-events', { entityId: TASK_2 }))).toEqual([40, 30]);
      expect(
        minutesOf(await api.get('/audit-events', { entityType: 'site', entityId: TASK_1 })),
      ).toEqual([]);
    });

    it('matches % and _ in an action or event type prefix literally, not as wildcards', async () => {
      await seedEvents();
      // "task_" as a LIKE pattern would also match "task." (every task event); literally it
      // matches only "task_list.created" (minute 50, sequence 6).
      expect(minutesOf(await api.get('/audit-events', { action: 'task_*' }))).toEqual([50]);
      expect(minutesOf(await api.get('/audit-events', { action: 'task_list.' }))).toEqual([50]);
      expect(minutesOf(await api.get('/audit-events', { action: 't%.*' }))).toEqual([]);
      expect(minutesOf(await api.get('/audit-events', { action: '%*' }))).toEqual([]);
      expect(minutesOf(await api.get('/audit-events', { action: 'tas_.' }))).toEqual([]);
      // An exact match never was a pattern.
      expect(minutesOf(await api.get('/audit-events', { action: 'task_created' }))).toEqual([]);

      const sequences = async (eventType: string) =>
        ((await api.get('/outbox-events', { eventType })).body.items as Json[]).map(
          (item) => item.sequence,
        );
      expect(await sequences('task_*')).toEqual(['6']);
      expect(await sequences('t%.*')).toEqual([]);
      expect(await sequences('%*')).toEqual([]);
      expect(await sequences('tas_.')).toEqual([]);
    });

    it('filters by action: exact, or as a prefix with a trailing dot or asterisk', async () => {
      await seedEvents();
      expect(minutesOf(await api.get('/audit-events', { action: 'task.created' }))).toEqual([
        30, 0,
      ]);
      expect(minutesOf(await api.get('/audit-events', { action: 'task.' }))).toEqual([
        40, 30, 10, 0,
      ]);
      expect(minutesOf(await api.get('/audit-events', { action: 'task.*' }))).toEqual([
        40, 30, 10, 0,
      ]);
      // An exact name does not match longer names, and "task" is not "task.".
      expect(minutesOf(await api.get('/audit-events', { action: 'task' }))).toEqual([]);
      expect(minutesOf(await api.get('/audit-events', { action: 'task.create' }))).toEqual([]);
      expect(minutesOf(await api.get('/audit-events', { action: 'task*' }))).toEqual([
        50, 40, 30, 10, 0,
      ]);
      expect(minutesOf(await api.get('/audit-events', { action: 'site.' }))).toEqual([20]);
    });

    it('filters by actor and by correlation id', async () => {
      await seedEvents();
      expect(minutesOf(await api.get('/audit-events', { actorId: ACTOR_2 }))).toEqual([40, 30]);
      expect(minutesOf(await api.get('/audit-events', { correlationId: 'corr-4' }))).toEqual([
        40, 30,
      ]);
      // corr-1 is also used by another organization and by a system event: neither is returned.
      expect(minutesOf(await api.get('/audit-events', { correlationId: 'corr-1' }))).toEqual([0]);
      expect(minutesOf(await api.get('/audit-events', { correlationId: 'corr-none' }))).toEqual([]);
    });

    it('filters by date range: from is inclusive, to is exclusive', async () => {
      await seedEvents();
      const iso = (minute: number, ms = 0) => new Date(at(minute).getTime() + ms).toISOString();

      expect(minutesOf(await api.get('/audit-events', { from: iso(20) }))).toEqual([
        50, 40, 30, 20,
      ]);
      expect(minutesOf(await api.get('/audit-events', { from: iso(20, 1) }))).toEqual([50, 40, 30]);
      expect(minutesOf(await api.get('/audit-events', { to: iso(20) }))).toEqual([10, 0]);
      expect(minutesOf(await api.get('/audit-events', { to: iso(20, 1) }))).toEqual([20, 10, 0]);
      expect(minutesOf(await api.get('/audit-events', { from: iso(10), to: iso(30) }))).toEqual([
        20, 10,
      ]);
      // Two adjacent ranges cover every event exactly once.
      const firstHalf = minutesOf(await api.get('/audit-events', { to: iso(30) }));
      const secondHalf = minutesOf(await api.get('/audit-events', { from: iso(30) }));
      expect([...secondHalf, ...firstHalf]).toEqual([50, 40, 30, 20, 10, 0]);
      expect(minutesOf(await api.get('/audit-events', { from: iso(20), to: iso(20) }))).toEqual([]);
      expect(minutesOf(await api.get('/audit-events', { from: iso(30), to: iso(10) }))).toEqual([]);
      // The same instant written with an offset.
      expect(minutesOf(await api.get('/audit-events', { from: atWithOffset(20, 3) }))).toEqual([
        50, 40, 30, 20,
      ]);
    });

    it('combines filters with AND, sorts both ways and pages', async () => {
      await seedEvents();
      expect(
        minutesOf(
          await api.get('/audit-events', {
            action: 'task.',
            actorId: ACTOR_2,
            from: at(35).toISOString(),
          }),
        ),
      ).toEqual([40]);
      expect(minutesOf(await api.get('/audit-events', { sort: 'occurredAt:asc' }))).toEqual([
        0, 10, 20, 30, 40, 50,
      ]);
      const second = await api.get('/audit-events', { page: 2, pageSize: 4 });
      expect(minutesOf(second)).toEqual([10, 0]);
      expect(second.body).toMatchObject({ page: 2, pageSize: 4, total: 6 });
    });

    it.each([
      ['a sort field that is not allowed', { sort: 'action:asc' }],
      ['a from that is only a date', { from: '2026-09-01' }],
      ['a to without an offset', { to: '2026-09-01T08:00:00' }],
      ['page size 101', { pageSize: 101 }],
      ['page 0', { page: 0 }],
      ['an empty action', { action: ' ' }],
    ])('rejects %s (400)', async (_name, query) => {
      const response = await api.get('/audit-events', query);
      expect(response.status).toBe(400);
      expect(apiErrorSchema.safeParse(response.body).success).toBe(true);
    });

    it('gets one event by id; 404 for an unknown id, 400 for a bad one', async () => {
      await seedEvents();
      const listed = await api.get('/audit-events', { correlationId: 'corr-3' });
      const id = listed.body.items[0].id as string;

      const response = await api.get(`/audit-events/${id}`);
      expect(response.status).toBe(200);
      expect(auditEventSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toEqual(listed.body.items[0]);
      expect((await api.get(`/audit-events/${unknownId()}`)).status).toBe(404);
      expect((await api.get('/audit-events/latest')).status).toBe(400);
    });

    it('does not return system events without an organization to any caller', async () => {
      await seedEvents();
      const system = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { organizationId: null },
      });
      expect((await api.get(`/audit-events/${system.id}`)).status).toBe(404);
      expect((await ctx.as(other.admin.id).get(`/audit-events/${system.id}`)).status).toBe(404);
      expect((await ctx.as(other.admin.id).get('/audit-events')).body.total).toBe(1);
    });

    it('shows a real change end to end: write, then read it back filtered', async () => {
      const created = await api.post('/tasks', { title: 'Fix the door' });
      await api.patch(`/tasks/${created.body.id}/status`, { status: 'done' });

      const trail = await api.get('/audit-events', {
        entityType: 'task',
        entityId: created.body.id,
        sort: 'occurredAt:asc',
      });

      expect((trail.body.items as Json[]).map((item) => item.action)).toEqual([
        'task.created',
        'task.status_changed',
      ]);
      expect(trail.body.items[1].changes.status).toEqual({ from: 'todo', to: 'done' });
      const byRequest = await api.get('/audit-events', {
        correlationId: created.requestId as string,
      });
      expect(byRequest.body.total).toBe(1);
      expect(byRequest.body.items[0].entityId).toBe(created.body.id);
    });
  });

  describe('GET /outbox-events', () => {
    const sequencesOf = (response: { body: Json }) =>
      (response.body.items as Json[]).map((item) => item.sequence);

    // Sequences of the caller's six events: the two noise rows were inserted last (7 and 8).
    it('returns the envelope in sequence order, with sequence serialized as a string', async () => {
      await seedEvents();
      const response = await api.get('/outbox-events');
      expect(response.status).toBe(200);
      expect(outboxEventListSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({ page: 1, pageSize: 25, total: 6 });
      expect(sequencesOf(response)).toEqual(['1', '2', '3', '4', '5', '6']);
      for (const item of response.body.items as Json[]) {
        expect(typeof item.sequence).toBe('string');
        expect(item.sequence).toMatch(/^\d+$/);
      }
      expect(response.body.items[0]).toEqual({
        id: expect.any(String),
        sequence: '1',
        organizationId: orgId(),
        eventType: 'task.created',
        aggregateType: 'task',
        aggregateId: TASK_1,
        payload: { id: TASK_1 },
        actorId: tenant.admin.id,
        correlationId: 'corr-1',
        occurredAt: at(0).toISOString(),
        processedAt: null,
      });
      // The raw JSON carries a quoted number, so no client can lose precision on it.
      expect(response.text).toContain('"sequence":"1"');
    });

    it('keeps a sequence beyond 2^53 exact', async () => {
      const big = 9007199254740993n;
      await ctx.prisma.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"OutboxEvent"', 'sequence'), ${big - 1n})`,
      );
      await api.post('/sites', { name: 'Depot' });

      const response = await api.get('/outbox-events');

      expect(sequencesOf(response)).toEqual(['9007199254740993']);
      const after = await api.get('/outbox-events', { afterSequence: '9007199254740992' });
      expect(after.body.total).toBe(1);
      expect(
        (await api.get('/outbox-events', { afterSequence: '9007199254740993' })).body.total,
      ).toBe(0);
    });

    it('filters by event type: exact or prefix', async () => {
      await seedEvents();
      expect(sequencesOf(await api.get('/outbox-events', { eventType: 'task.created' }))).toEqual([
        '1',
        '4',
      ]);
      expect(sequencesOf(await api.get('/outbox-events', { eventType: 'task.' }))).toEqual([
        '1',
        '2',
        '4',
        '5',
      ]);
      expect(sequencesOf(await api.get('/outbox-events', { eventType: 'task.*' }))).toEqual([
        '1',
        '2',
        '4',
        '5',
      ]);
      expect(sequencesOf(await api.get('/outbox-events', { eventType: 'task' }))).toEqual([]);
      expect(sequencesOf(await api.get('/outbox-events', { eventType: 'site.created' }))).toEqual([
        '3',
      ]);
    });

    it('filters by aggregate type and id', async () => {
      await seedEvents();
      expect(sequencesOf(await api.get('/outbox-events', { aggregateType: 'task' }))).toEqual([
        '1',
        '2',
        '4',
        '5',
      ]);
      expect(
        sequencesOf(
          await api.get('/outbox-events', { aggregateType: 'task', aggregateId: TASK_2 }),
        ),
      ).toEqual(['4', '5']);
      expect(sequencesOf(await api.get('/outbox-events', { aggregateId: SITE_1 }))).toEqual(['3']);
    });

    it('reads after a cursor: only greater sequences, never the cursor itself', async () => {
      await seedEvents();
      expect(sequencesOf(await api.get('/outbox-events', { afterSequence: '0' }))).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
      ]);
      expect(sequencesOf(await api.get('/outbox-events', { afterSequence: '3' }))).toEqual([
        '4',
        '5',
        '6',
      ]);
      expect(sequencesOf(await api.get('/outbox-events', { afterSequence: '6' }))).toEqual([]);
      // 7 and 8 belong to another organization and to nobody: the cursor does not reveal them.
      expect((await api.get('/outbox-events', { afterSequence: '6' })).body.total).toBe(0);
      expect(
        sequencesOf(await api.get('/outbox-events', { afterSequence: '2', eventType: 'task.' })),
      ).toEqual(['4', '5']);
    });

    it('lets a consumer page through everything with the cursor', async () => {
      await seedEvents();
      const seen: string[] = [];
      let cursor = '0';
      for (let round = 0; round < 10; round += 1) {
        const batch = await api.get('/outbox-events', { afterSequence: cursor, pageSize: 4 });
        const sequences = sequencesOf(batch);
        if (sequences.length === 0) {
          break;
        }
        seen.push(...sequences);
        cursor = sequences[sequences.length - 1] as string;
      }
      expect(seen).toEqual(['1', '2', '3', '4', '5', '6']);
    });

    it.each([
      ['a word', 'last'],
      ['a negative number', '-1'],
      ['a decimal', '1.5'],
      ['an exponent', '1e3'],
      ['more than 19 digits', '12345678901234567890'],
    ])('rejects afterSequence that is %s (400)', async (_name, afterSequence) => {
      const response = await api.get('/outbox-events', { afterSequence });
      expect(response.status).toBe(400);
      expect(response.body.details[0].path).toBe('afterSequence');
    });

    it.each([['9223372036854775808'], ['9999999999999999999']])(
      'rejects the 19-digit afterSequence %s, which is above the 64-bit range (400)',
      async (afterSequence) => {
        await seedEvents();
        const response = await api.get('/outbox-events', { afterSequence });
        expect(response.status).toBe(400);
        expect(response.body.details).toEqual([
          { path: 'afterSequence', message: 'must fit in a signed 64-bit integer' },
        ]);
      },
    );

    it('accepts the largest 64-bit cursor', async () => {
      await seedEvents();
      const response = await api.get('/outbox-events', { afterSequence: '9223372036854775807' });
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(0);
    });

    it('filters by processed state', async () => {
      await seedEvents();
      await ctx.prisma.outboxEvent.updateMany({
        where: { sequence: { in: [2n, 5n] } },
        data: { processedAt: at(100) },
      });

      const processed = await api.get('/outbox-events', { processed: true });
      expect(sequencesOf(processed)).toEqual(['2', '5']);
      expect(processed.body.items[0].processedAt).toBe(at(100).toISOString());
      expect(sequencesOf(await api.get('/outbox-events', { processed: false }))).toEqual([
        '1',
        '3',
        '4',
        '6',
      ]);
      expect((await api.get('/outbox-events', { processed: 'maybe' })).status).toBe(400);
    });

    it('filters by date range (from inclusive, to exclusive) and sorts by sequence or time', async () => {
      await seedEvents();
      expect(
        sequencesOf(
          await api.get('/outbox-events', { from: at(10).toISOString(), to: at(30).toISOString() }),
        ),
      ).toEqual(['2', '3']);
      expect(
        sequencesOf(
          await api.get('/outbox-events', {
            from: at(10).toISOString(),
            to: new Date(at(30).getTime() + 1).toISOString(),
          }),
        ),
      ).toEqual(['2', '3', '4']);
      expect(sequencesOf(await api.get('/outbox-events', { to: at(0).toISOString() }))).toEqual([]);
      expect(sequencesOf(await api.get('/outbox-events', { sort: 'sequence:desc' }))).toEqual([
        '6',
        '5',
        '4',
        '3',
        '2',
        '1',
      ]);
      expect(
        sequencesOf(await api.get('/outbox-events', { sort: 'occurredAt:desc', pageSize: 2 })),
      ).toEqual(['6', '5']);
      expect((await api.get('/outbox-events', { sort: 'eventType:asc' })).status).toBe(400);
    });

    it('gets one event by id; 404 for an unknown id or one without an organization', async () => {
      await seedEvents();
      const listed = await api.get('/outbox-events', { aggregateId: SITE_1 });
      const response = await api.get(`/outbox-events/${listed.body.items[0].id}`);
      expect(response.status).toBe(200);
      expect(outboxEventSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toEqual(listed.body.items[0]);

      const system = await ctx.prisma.outboxEvent.findFirstOrThrow({
        where: { organizationId: null },
      });
      expect((await api.get(`/outbox-events/${system.id}`)).status).toBe(404);
      expect((await api.get(`/outbox-events/${unknownId()}`)).status).toBe(404);
    });
  });

  describe('no write routes', () => {
    const WRITES: Array<[string, string]> = [
      ['POST', ''],
      ['PUT', ''],
      ['PATCH', ''],
      ['DELETE', ''],
      ['POST', '/:id'],
      ['PUT', '/:id'],
      ['PATCH', '/:id'],
      ['DELETE', '/:id'],
      ['POST', '/:id/archive'],
      ['POST', '/:id/processed'],
    ];

    it.each(
      ['audit-events', 'outbox-events'].flatMap((resource) =>
        WRITES.map(([method, suffix]) => [method, resource, suffix]),
      ),
    )(
      '%s /%s%s does not exist (404 or 405) and changes nothing',
      async (method, resource, suffix) => {
        await seedEvents();
        const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
          where: { organizationId: orgId() },
          orderBy: { occurredAt: 'asc' },
        });
        const outbox = await ctx.prisma.outboxEvent.findFirstOrThrow({
          where: { organizationId: orgId() },
          orderBy: { sequence: 'asc' },
        });
        const id = resource === 'audit-events' ? audit.id : outbox.id;

        const response = await api.request(
          method as string,
          `/${resource}${(suffix as string).replace(':id', id)}`,
          {
            body: {
              id: randomUUID(),
              action: 'task.forged',
              eventType: 'task.forged',
              entityType: 'task',
              entityId: TASK_1,
              processedAt: at().toISOString(),
            },
          },
        );

        expect([404, 405]).toContain(response.status);
        expect(apiErrorSchema.safeParse(response.body).success).toBe(true);
        expect(await eventCounts(ctx.prisma)).toEqual({ audit: 8, outbox: 8 });
        expect(await ctx.prisma.auditEvent.findUniqueOrThrow({ where: { id: audit.id } })).toEqual(
          audit,
        );
        expect(
          await ctx.prisma.outboxEvent.findUniqueOrThrow({ where: { id: outbox.id } }),
        ).toEqual(outbox);
      },
    );
  });
});
