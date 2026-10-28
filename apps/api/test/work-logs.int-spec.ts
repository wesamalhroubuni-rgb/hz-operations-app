import { randomUUID } from 'node:crypto';
import {
  attachmentSchema,
  attachmentUploadSchema,
  WORK_LOG_MAX_FUTURE_MS,
  workLogListSchema,
  workLogSchema,
} from '@ops/shared';
import {
  at,
  atWithOffset,
  createLogType,
  createMembership,
  createSite,
  createTask,
  createTeam,
  createTenant,
  createUser,
  createWorkLog,
  eventCounts,
  unknownId,
  type Tenant,
} from './support/factories';
import { MAX_ATTACHMENTS_PER_WORK_LOG } from '../src/operations/access';
import { FakeFileStorage } from './support/fake-file-storage';
import { makeJpeg, makePng, textBytes } from './support/test-images';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

/** The ISO string of a moment plus some milliseconds. */
function plusMs(date: Date, milliseconds: number): string {
  return new Date(date.getTime() + milliseconds).toISOString();
}

describe('work logs', () => {
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
  const texts = (response: { body: Json }) =>
    (response.body.items as Json[]).map((item) => item.text);
  const detailPaths = (response: { body: Json }) =>
    (response.body.details as Json[]).map((detail) => detail.path).sort();

  /** A minimal valid body; every call gets a new clientId unless one is given. */
  function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { clientId: randomUUID(), occurredAt: at().toISOString(), ...extra };
  }

  describe('create', () => {
    it('creates a log with a log type and valid custom fields (201)', async () => {
      const [site, team, logType] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
        createLogType(ctx.prisma, orgId(), { version: 3 }),
      ]);
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      const clientId = randomUUID();

      const response = await api.post('/work-logs', {
        clientId,
        occurredAt: atWithOffset(30, 3),
        taskId: task.id,
        siteId: site.id,
        teamId: team.id,
        logTypeId: logType.id,
        text: '  Checked the roof drains  ',
        customFields: {
          area: 'Roof',
          quantity: 12.5,
          passed: true,
          result: 'ok',
          next_check: '2026-11-01',
        },
        location: { latitude: 41.0082, longitude: 28.9784, accuracy: 8.5 },
      });

      expect(response.status).toBe(201);
      expect(workLogSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        organizationId: orgId(),
        clientId,
        authorId: tenant.admin.id,
        occurredAt: at(30).toISOString(),
        taskId: task.id,
        siteId: site.id,
        teamId: team.id,
        logTypeId: logType.id,
        logTypeVersion: 3,
        text: 'Checked the roof drains',
        customFields: {
          area: 'Roof',
          quantity: 12.5,
          passed: true,
          result: 'ok',
          next_check: '2026-11-01',
        },
        location: { latitude: 41.0082, longitude: 28.9784, accuracy: 8.5 },
        status: 'submitted',
        source: 'manual',
        aiMetadata: null,
        archivedAt: null,
      });
      // occurredAt (when the work happened) and createdAt (when it was stored) are separate.
      expect(response.body.createdAt).not.toBe(response.body.occurredAt);
      expect(new Date(response.body.createdAt).getTime()).toBeGreaterThan(at().getTime());
      expect((await api.get(`/work-logs/${response.body.id}`)).body).toEqual(response.body);
    });

    it('creates a plain log without a log type: no version, no custom fields, no location', async () => {
      const response = await api.post('/work-logs', body({ text: 'Swept the yard' }));
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        authorId: tenant.admin.id,
        logTypeId: null,
        logTypeVersion: null,
        customFields: {},
        location: null,
        taskId: null,
        siteId: null,
        teamId: null,
      });
    });

    it('drops null custom field values and keeps only fields that have a value', async () => {
      const logType = await createLogType(ctx.prisma, orgId());
      const response = await api.post(
        '/work-logs',
        body({
          logTypeId: logType.id,
          customFields: { area: 'Roof', quantity: 0, passed: null, result: null },
        }),
      );
      expect(response.status).toBe(201);
      expect(response.body.customFields).toEqual({ area: 'Roof', quantity: 0 });
    });

    it('accepts a draft and another source, and a location without accuracy', async () => {
      const response = await api.post(
        '/work-logs',
        body({ status: 'draft', source: 'voice', location: { latitude: -33.9, longitude: 151.2 } }),
      );
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'draft',
        source: 'voice',
        location: { latitude: -33.9, longitude: 151.2, accuracy: null },
      });
    });

    it('refuses a body that names authorId (400): the author is always the signed-in user', async () => {
      const worker = await createUser(ctx.prisma, orgId());
      const response = await api.post('/work-logs', body({ authorId: worker.id }));
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('validation_failed');
      expect(detailPaths(response)).toEqual(['authorId']);
      expect(await ctx.prisma.workLog.count()).toBe(0);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });

      // Without it the author is the caller, and the audit trail names the same user.
      const created = await api.post('/work-logs', body());
      expect(created.status).toBe(201);
      expect(created.body.authorId).toBe(tenant.admin.id);
      const audit = await ctx.prisma.auditEvent.findFirstOrThrow();
      expect(audit.actorId).toBe(tenant.admin.id);
    });

    describe('custom fields', () => {
      it('rejects invalid values (400) with one customFields.<key> detail per problem', async () => {
        const logType = await createLogType(ctx.prisma, orgId());

        const response = await api.post(
          '/work-logs',
          body({
            logTypeId: logType.id,
            customFields: {
              quantity: 'twelve',
              passed: 'yes',
              result: 'maybe',
              next_check: 'tomorrow',
              colour: 'red',
            },
          }),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation_failed',
          message: 'The custom fields are not valid for this log type',
        });
        expect(response.body.details).toEqual([
          { path: 'customFields.colour', message: 'is not a field of this log type' },
          { path: 'customFields.area', message: 'is required' },
          { path: 'customFields.quantity', message: 'must be a number' },
          { path: 'customFields.passed', message: 'must be true or false' },
          { path: 'customFields.result', message: 'must be one of: ok, defect' },
          {
            path: 'customFields.next_check',
            message: 'must be an ISO date (YYYY-MM-DD) or an ISO datetime with an offset',
          },
        ]);
        expect(await ctx.prisma.workLog.count()).toBe(0);
        expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
      });

      it('rejects a log of a type with required fields when customFields is left out (400)', async () => {
        const logType = await createLogType(ctx.prisma, orgId());
        const response = await api.post('/work-logs', body({ logTypeId: logType.id }));
        expect(response.status).toBe(400);
        expect(detailPaths(response)).toEqual(['customFields.area', 'customFields.quantity']);
      });

      it('rejects custom fields without a log type (400)', async () => {
        const response = await api.post('/work-logs', body({ customFields: { area: 'Roof' } }));
        expect(response.status).toBe(400);
        expect(response.body.details).toEqual([
          { path: 'customFields', message: 'must be empty when the log has no log type' },
        ]);
        expect(await ctx.prisma.workLog.count()).toBe(0);
      });

      it('accepts empty custom fields without a log type, and with a type that has no fields', async () => {
        const empty = await createLogType(ctx.prisma, orgId(), { fields: [] });
        expect((await api.post('/work-logs', body({ customFields: {} }))).status).toBe(201);
        const typed = await api.post('/work-logs', body({ logTypeId: empty.id }));
        expect(typed.status).toBe(201);
        expect(typed.body).toMatchObject({ logTypeVersion: 1, customFields: {} });
      });

      it.each([
        ['a list', ['Roof']],
        ['a string', 'area=Roof'],
        ['a number', 5],
      ])('rejects customFields sent as %s (400)', async (_name, customFields) => {
        const logType = await createLogType(ctx.prisma, orgId());
        const response = await api.post(
          '/work-logs',
          body({ logTypeId: logType.id, customFields }),
        );
        expect(response.status).toBe(400);
        expect(detailPaths(response)).toEqual(['customFields']);
      });

      it('validates against the log type of the caller’s organization only', async () => {
        const foreignType = await createLogType(ctx.prisma, other.organization.id);
        const response = await api.post(
          '/work-logs',
          body({ logTypeId: foreignType.id, customFields: { area: 'Roof', quantity: 1 } }),
        );
        expect(response.status).toBe(422);
        expect(detailPaths(response)).toEqual(['logTypeId']);
      });
    });

    describe('location', () => {
      it.each([
        ['latitude without longitude', { latitude: 41 }, ['location.longitude']],
        ['longitude without latitude', { longitude: 29 }, ['location.latitude']],
        ['an empty location', {}, ['location.latitude', 'location.longitude']],
        ['latitude above 90', { latitude: 91, longitude: 29 }, ['location.latitude']],
        ['longitude below -180', { latitude: 41, longitude: -181 }, ['location.longitude']],
        [
          'coordinates sent as text',
          { latitude: '41', longitude: '29' },
          ['location.latitude', 'location.longitude'],
        ],
        [
          'a negative accuracy',
          { latitude: 41, longitude: 29, accuracy: -1 },
          ['location.accuracy'],
        ],
        ['a null longitude', { latitude: 41, longitude: null }, ['location.longitude']],
      ])('rejects %s (400)', async (_name, location, paths) => {
        const response = await api.post('/work-logs', body({ location }));
        expect(response.status).toBe(400);
        expect(detailPaths(response)).toEqual(paths);
        expect(await ctx.prisma.workLog.count()).toBe(0);
      });

      it.each([
        ['a latitude without a longitude', { latitude: 41 }, ['latitude']],
        ['latitude and longitude', { latitude: 41, longitude: 29 }, ['latitude', 'longitude']],
      ])(
        'rejects %s sent outside the location object (400), naming the keys',
        async (_name, flat, keys) => {
          const response = await api.post('/work-logs', body(flat));
          expect(response.status).toBe(400);
          expect(response.body.code).toBe('validation_failed');
          for (const key of keys) {
            expect(response.body.details).toContainEqual({
              path: key,
              message: 'is not a recognised field',
            });
          }
          expect(await ctx.prisma.workLog.count()).toBe(0);
          expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
        },
      );

      it('rejects an unknown key inside the location object (400)', async () => {
        const response = await api.post(
          '/work-logs',
          body({ location: { latitude: 41, longitude: 29, altitude: 100 } }),
        );
        expect(response.status).toBe(400);
        expect(response.body.details).toEqual([
          { path: 'location.altitude', message: 'is not a recognised field' },
        ]);
        expect(await ctx.prisma.workLog.count()).toBe(0);
      });

      it('rejects an unknown key inside the location of an update (400) and keeps the log', async () => {
        const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
        const response = await api.patch(`/work-logs/${workLog.id}`, {
          location: { latitude: 41, longitude: 29, heading: 90 },
        });
        expect(response.status).toBe(400);
        expect(response.body.details).toEqual([
          { path: 'location.heading', message: 'is not a recognised field' },
        ]);
        expect(await ctx.prisma.workLog.findUniqueOrThrow({ where: { id: workLog.id } })).toEqual(
          workLog,
        );
      });

      it('accepts the edges of the globe', async () => {
        const response = await api.post(
          '/work-logs',
          body({ location: { latitude: -90, longitude: 180, accuracy: 0 } }),
        );
        expect(response.status).toBe(201);
        expect(response.body.location).toEqual({ latitude: -90, longitude: 180, accuracy: 0 });
      });
    });

    describe('occurredAt', () => {
      it('rejects a time more than the margin in the future (422 occurred_at_out_of_range)', async () => {
        const occurredAt = new Date(Date.now() + 2 * WORK_LOG_MAX_FUTURE_MS).toISOString();
        const response = await api.post('/work-logs', body({ occurredAt }));
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('occurred_at_out_of_range');
        expect(response.body.details).toEqual([
          { path: 'occurredAt', message: 'must not be more than one hour in the future' },
        ]);
        expect(await ctx.prisma.workLog.count()).toBe(0);
      });

      it('rejects a far future date (422)', async () => {
        const response = await api.post('/work-logs', body({ occurredAt: '2099-01-01T00:00:00Z' }));
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('occurred_at_out_of_range');
      });

      it('allows a small margin for a phone clock that runs fast', async () => {
        const occurredAt = new Date(Date.now() + WORK_LOG_MAX_FUTURE_MS / 2).toISOString();
        expect((await api.post('/work-logs', body({ occurredAt }))).status).toBe(201);
      });

      it('accepts work up to the backdating limit (7 days by default) and refuses older', async () => {
        const day = 86_400_000;
        const inside = new Date(Date.now() - 7 * day + 60_000).toISOString();
        const response = await api.post('/work-logs', body({ occurredAt: inside }));
        expect(response.status).toBe(201);
        expect(response.body.occurredAt).toBe(inside);

        const tooOld = new Date(Date.now() - 7 * day - 60_000).toISOString();
        const refused = await api.post('/work-logs', body({ occurredAt: tooOld }));
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({
          code: 'occurred_at_out_of_range',
          details: [{ path: 'occurredAt', message: 'must not be more than 7 days in the past' }],
        });
      });

      it("follows the organization's offlineMaxBackdateDays setting", async () => {
        await ctx.prisma.organization.update({
          where: { id: orgId() },
          data: { settings: { offlineMaxBackdateDays: 30 } },
        });
        const occurredAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
        expect((await api.post('/work-logs', body({ occurredAt }))).status).toBe(201);
        const tooOld = new Date(Date.now() - 31 * 86_400_000).toISOString();
        expect((await api.post('/work-logs', body({ occurredAt: tooOld }))).status).toBe(422);
      });

      it.each([
        ['missing', undefined],
        ['a date without a time', '2026-09-01'],
        ['a datetime without an offset', '2026-09-01T08:00:00'],
        ['a timestamp number', 1_788_000_000_000],
        ['words', 'this morning'],
      ])('rejects occurredAt that is %s (400)', async (_name, occurredAt) => {
        const response = await api.post('/work-logs', { clientId: randomUUID(), occurredAt });
        expect(response.status).toBe(400);
        expect(detailPaths(response)).toEqual(['occurredAt']);
      });
    });

    describe('other validation', () => {
      it.each([
        ['a missing clientId', { clientId: undefined }],
        ['a clientId that is not a UUID', { clientId: 'device-1-log-7' }],
        ['an unknown status', { status: 'sent' }],
        ['an unknown source', { source: 'drone' }],
        ['aiMetadata, which is reserved', { aiMetadata: { summary: 'x' } }],
        ['a text over 10000 characters', { text: 'x'.repeat(10_001) }],
        ['an authorId that is not a UUID', { authorId: 'me' }],
      ])('rejects %s (400)', async (_name, extra) => {
        const response = await api.post('/work-logs', body(extra));
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('validation_failed');
        expect(await ctx.prisma.workLog.count()).toBe(0);
      });
    });

    describe('references', () => {
      it('rejects references to another organization (422), naming each field', async () => {
        const o = other.organization.id;
        const [site, team, logType] = await Promise.all([
          createSite(ctx.prisma, o),
          createTeam(ctx.prisma, o),
          createLogType(ctx.prisma, o),
        ]);
        const task = await createTask(ctx.prisma, o, other.admin.id);

        const response = await api.post(
          '/work-logs',
          body({
            taskId: task.id,
            siteId: site.id,
            teamId: team.id,
            logTypeId: logType.id,
            customFields: { area: 'Roof', quantity: 1 },
          }),
        );

        expect(response.status).toBe(422);
        expect(response.body.code).toBe('unprocessable');
        expect(detailPaths(response)).toEqual(['logTypeId', 'siteId', 'taskId', 'teamId']);
        expect(await ctx.prisma.workLog.count()).toBe(0);
      });

      it.each([
        ['an archived site', 'siteId', () => createSite(ctx.prisma, orgId(), { archivedAt: at() })],
        ['an archived team', 'teamId', () => createTeam(ctx.prisma, orgId(), { archivedAt: at() })],
        [
          'an archived task',
          'taskId',
          () => createTask(ctx.prisma, orgId(), tenant.admin.id, { archivedAt: at() }),
        ],
        [
          'an archived log type',
          'logTypeId',
          () => createLogType(ctx.prisma, orgId(), { archivedAt: at() }),
        ],
      ])('rejects %s (422)', async (_name, field, create) => {
        const record = await create();
        const response = await api.post('/work-logs', body({ [field]: record.id }));
        expect(response.status).toBe(422);
        expect(detailPaths(response)).toEqual([field]);
      });

      it('rejects ids that name nothing (422)', async () => {
        const response = await api.post(
          '/work-logs',
          body({ siteId: unknownId(), taskId: unknownId() }),
        );
        expect(response.status).toBe(422);
        expect(detailPaths(response)).toEqual(['siteId', 'taskId']);
      });
    });
  });

  describe('idempotency on clientId', () => {
    it('answers 200 with the same log for a repeated clientId and records nothing more', async () => {
      const request = body({ text: 'Checked the roof' });

      const first = await api.post('/work-logs', request);
      const second = await api.post('/work-logs', request);
      const third = await api.post('/work-logs', request);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);
      expect(await ctx.prisma.workLog.count()).toBe(1);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
    });

    it('returns the stored log unchanged when the retry carries different content', async () => {
      const clientId = randomUUID();
      const first = await api.post('/work-logs', body({ clientId, text: 'Original' }));

      const retry = await api.post(
        '/work-logs',
        body({ clientId, text: 'Edited on the phone', occurredAt: at(90).toISOString() }),
      );

      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(retry.body.text).toBe('Original');
      const stored = await ctx.prisma.workLog.findMany();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.updatedAt.toISOString()).toBe(first.body.updatedAt);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
    });

    it('answers 409 when another user of the organization reuses the clientId, and leaks nothing', async () => {
      const second = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), second.id, 'worker');
      const request = body({ text: 'Private text of the first author' });
      const first = await api.post('/work-logs', request);
      expect(first.status).toBe(201);

      const retry = await ctx.as(second.id).post('/work-logs', request);
      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe('conflict');
      expect(retry.body.details).toEqual([{ path: 'clientId', message: 'is already in use' }]);
      expect(retry.text).not.toContain(first.body.id);
      expect(retry.text).not.toContain('Private text');
      expect(retry.text).not.toContain(tenant.admin.id);
      expect(await ctx.prisma.workLog.count()).toBe(1);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
    });

    it('creates one row for concurrent identical requests', async () => {
      const request = body({ text: 'Sent five times at once' });

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => api.post('/work-logs', request)),
      );

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
      expect(await ctx.prisma.workLog.count()).toBe(1);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
      for (const response of responses) {
        expect(response.body).toEqual(responses[0]?.body);
      }
    });

    it('creates one row per clientId for a concurrent burst of different logs', async () => {
      const requests = Array.from({ length: 4 }, (_item, index) => body({ text: `Log ${index}` }));

      const responses = await Promise.all(
        [...requests, ...requests].map((request) => api.post('/work-logs', request)),
      );

      expect(responses.filter((response) => response.status === 201)).toHaveLength(4);
      expect(responses.filter((response) => response.status === 200)).toHaveLength(4);
      expect(await ctx.prisma.workLog.count()).toBe(4);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 4, outbox: 4 });
    });

    it('creates two logs for the same clientId in two organizations', async () => {
      const request = body({ text: 'Same device id' });

      const mine = await api.post('/work-logs', request);
      const theirs = await ctx.as(other.admin.id).post('/work-logs', request);

      expect([mine.status, theirs.status]).toEqual([201, 201]);
      expect(theirs.body.id).not.toBe(mine.body.id);
      expect(mine.body.organizationId).toBe(orgId());
      expect(theirs.body.organizationId).toBe(other.organization.id);
      expect(
        await ctx.prisma.workLog.count({ where: { clientId: request.clientId as string } }),
      ).toBe(2);
      expect(await eventCounts(ctx.prisma, orgId())).toEqual({ audit: 1, outbox: 1 });
      expect(await eventCounts(ctx.prisma, other.organization.id)).toEqual({ audit: 1, outbox: 1 });
    });

    it('returns an archived log for its clientId instead of creating a second one', async () => {
      const request = body();
      const first = await api.post('/work-logs', request);
      await api.post(`/work-logs/${first.body.id}/archive`);

      const retry = await api.post('/work-logs', request);

      expect(retry.status).toBe(200);
      expect(retry.body.id).toBe(first.body.id);
      expect(retry.body.archivedAt).not.toBeNull();
      expect(await ctx.prisma.workLog.count()).toBe(1);
    });

    it('does not create a log from a request that failed validation, so its retry can succeed', async () => {
      const logType = await createLogType(ctx.prisma, orgId());
      const clientId = randomUUID();
      const invalid = await api.post(
        '/work-logs',
        body({ clientId, logTypeId: logType.id, customFields: { area: 'Roof' } }),
      );
      expect(invalid.status).toBe(400);

      const fixed = await api.post(
        '/work-logs',
        body({ clientId, logTypeId: logType.id, customFields: { area: 'Roof', quantity: 2 } }),
      );
      expect(fixed.status).toBe(201);
      expect(await ctx.prisma.workLog.count()).toBe(1);
    });
  });

  describe('list', () => {
    interface Fixture {
      north: string;
      south: string;
      team: string;
      task: string;
      logType: string;
      ada: string;
      ben: string;
    }

    /** Five logs at at(0) (08:00 UTC) and the next four hours, plus an archived one. */
    async function seed(): Promise<Fixture> {
      const [north, south, team, logType, ada, ben] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
        createLogType(ctx.prisma, orgId(), { fields: [] }),
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id);
      const log = (
        text: string,
        hour: number,
        author: string,
        data: Parameters<typeof createWorkLog>[3],
      ) =>
        createWorkLog(ctx.prisma, orgId(), author, {
          text,
          occurredAt: at(hour * 60),
          // Stored in the opposite order, so occurredAt and createdAt sort differently.
          createdAt: at(1000 - hour),
          ...data,
        });

      await log('L0', 0, ada.id, { siteId: north.id, status: 'submitted' });
      await log('L1', 1, ada.id, { siteId: north.id, teamId: team.id, status: 'approved' });
      await log('L2', 2, ben.id, { siteId: south.id, taskId: task.id, status: 'submitted' });
      await log('L3', 3, ben.id, {
        teamId: team.id,
        logTypeId: logType.id,
        status: 'rejected',
        source: 'voice',
      });
      await log('L4', 4, ada.id, { status: 'draft' });
      await log('L5 archived', 5, ada.id, { siteId: north.id, archivedAt: at(999) });
      await createWorkLog(ctx.prisma, other.organization.id, other.admin.id, { text: 'Foreign' });
      return {
        north: north.id,
        south: south.id,
        team: team.id,
        task: task.id,
        logType: logType.id,
        ada: ada.id,
        ben: ben.id,
      };
    }

    it('returns the pagination envelope, most recent work first by default', async () => {
      await seed();
      const response = await api.get('/work-logs');
      expect(response.status).toBe(200);
      expect(workLogListSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({ page: 1, pageSize: 25, total: 5 });
      expect(texts(response)).toEqual(['L4', 'L3', 'L2', 'L1', 'L0']);
    });

    it('sorts by occurredAt or createdAt, in both directions', async () => {
      await seed();
      const sorted = async (sort: string) => texts(await api.get('/work-logs', { sort }));
      expect(await sorted('occurredAt:asc')).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
      expect(await sorted('occurredAt:desc')).toEqual(['L4', 'L3', 'L2', 'L1', 'L0']);
      expect(await sorted('createdAt:desc')).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
      expect(await sorted('createdAt:asc')).toEqual(['L4', 'L3', 'L2', 'L1', 'L0']);
      expect((await api.get('/work-logs', { sort: 'text:asc' })).status).toBe(400);
      expect((await api.get('/work-logs', { sort: 'updatedAt:desc' })).status).toBe(400);
    });

    it('filters by author', async () => {
      const f = await seed();
      expect(texts(await api.get('/work-logs', { authorId: f.ada }))).toEqual(['L4', 'L1', 'L0']);
      expect(texts(await api.get('/work-logs', { authorId: f.ben }))).toEqual(['L3', 'L2']);
      expect(texts(await api.get('/work-logs', { authorId: tenant.admin.id }))).toEqual([]);
    });

    it('filters by site, team, task and log type', async () => {
      const f = await seed();
      expect(texts(await api.get('/work-logs', { siteId: f.north }))).toEqual(['L1', 'L0']);
      expect(texts(await api.get('/work-logs', { siteId: f.south }))).toEqual(['L2']);
      expect(texts(await api.get('/work-logs', { teamId: f.team }))).toEqual(['L3', 'L1']);
      expect(texts(await api.get('/work-logs', { taskId: f.task }))).toEqual(['L2']);
      expect(texts(await api.get('/work-logs', { logTypeId: f.logType }))).toEqual(['L3']);
    });

    it('filters by status and source', async () => {
      await seed();
      expect(texts(await api.get('/work-logs', { status: 'submitted' }))).toEqual(['L2', 'L0']);
      expect(texts(await api.get('/work-logs', { status: 'approved' }))).toEqual(['L1']);
      expect(texts(await api.get('/work-logs', { status: 'rejected' }))).toEqual(['L3']);
      expect(texts(await api.get('/work-logs', { status: 'draft' }))).toEqual(['L4']);
      expect(texts(await api.get('/work-logs', { source: 'voice' }))).toEqual(['L3']);
      expect((await api.get('/work-logs', { status: 'pending' })).status).toBe(400);
    });

    it('filters by date range: occurredFrom is inclusive, occurredTo is exclusive', async () => {
      await seed();
      const range = async (query: Record<string, string>) =>
        texts(await api.get('/work-logs', { ...query, sort: 'occurredAt:asc' }));

      expect(await range({ occurredFrom: at(120).toISOString() })).toEqual(['L2', 'L3', 'L4']);
      expect(await range({ occurredFrom: plusMs(at(120), 1) })).toEqual(['L3', 'L4']);
      expect(await range({ occurredTo: at(120).toISOString() })).toEqual(['L0', 'L1']);
      expect(await range({ occurredTo: plusMs(at(120), 1) })).toEqual(['L0', 'L1', 'L2']);
      expect(
        await range({ occurredFrom: at(60).toISOString(), occurredTo: at(180).toISOString() }),
      ).toEqual(['L1', 'L2']);
      // A whole day, written in local time with an offset: nothing is counted twice or missed.
      expect(
        await range({
          occurredFrom: atWithOffset(-11 * 60, 3),
          occurredTo: atWithOffset(13 * 60, 3),
        }),
      ).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
      expect(
        await range({ occurredFrom: at(180).toISOString(), occurredTo: at(180).toISOString() }),
      ).toEqual([]);
      expect(
        await range({
          occurredFrom: at(16 * 60).toISOString(),
          occurredTo: at(-8 * 60).toISOString(),
        }),
      ).toEqual([]);
    });

    it.each([
      ['a date without a time', { occurredFrom: '2026-09-01' }],
      ['a datetime without an offset', { occurredTo: '2026-09-01T10:00:00' }],
      ['an author that is not a UUID', { authorId: 'ada' }],
      ['page size 101', { pageSize: 101 }],
    ])('rejects %s (400)', async (_name, query) => {
      expect((await api.get('/work-logs', query)).status).toBe(400);
    });

    it('combines filters with AND and counts the filtered set', async () => {
      const f = await seed();
      const response = await api.get('/work-logs', {
        authorId: f.ada,
        siteId: f.north,
        status: 'approved',
        occurredFrom: at(-8 * 60).toISOString(),
      });
      expect(texts(response)).toEqual(['L1']);
      expect(response.body.total).toBe(1);
      expect((await api.get('/work-logs', { authorId: f.ben, siteId: f.north })).body.total).toBe(
        0,
      );
    });

    it('includes archived logs only when asked, and pages through the result', async () => {
      await seed();
      const all = await api.get('/work-logs', { includeArchived: true });
      expect(all.body.total).toBe(6);
      expect(texts(all)[0]).toBe('L5 archived');

      const second = await api.get('/work-logs', { page: 2, pageSize: 2 });
      expect(texts(second)).toEqual(['L2', 'L1']);
      expect(second.body).toMatchObject({ page: 2, pageSize: 2, total: 5 });
      expect(texts(await api.get('/work-logs', { page: 4, pageSize: 2 }))).toEqual([]);
    });
  });

  describe('update, status and archive', () => {
    it('updates text, time, references and location; null clears them', async () => {
      const site = await createSite(ctx.prisma, orgId());
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id, { text: 'Old' });

      const updated = await api.patch(`/work-logs/${workLog.id}`, {
        text: 'New',
        occurredAt: at(30).toISOString(),
        siteId: site.id,
        location: { latitude: 41, longitude: 29, accuracy: 5 },
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        text: 'New',
        occurredAt: at(30).toISOString(),
        siteId: site.id,
        location: { latitude: 41, longitude: 29, accuracy: 5 },
        clientId: workLog.clientId,
        authorId: tenant.admin.id,
      });

      const cleared = await api.patch(`/work-logs/${workLog.id}`, {
        text: null,
        siteId: null,
        location: null,
      });
      expect(cleared.body).toMatchObject({ text: null, siteId: null, location: null });
      expect(cleared.body.occurredAt).toBe(at(30).toISOString());
    });

    it('re-validates custom fields against the current definition and records its version', async () => {
      const logType = await createLogType(ctx.prisma, orgId());
      const created = await api.post(
        '/work-logs',
        body({ logTypeId: logType.id, customFields: { area: 'Roof', quantity: 1 } }),
      );
      await ctx.prisma.logType.update({ where: { id: logType.id }, data: { version: 7 } });

      const invalid = await api.patch(`/work-logs/${created.body.id}`, {
        customFields: { area: 'Roof', quantity: 'two' },
      });
      expect(invalid.status).toBe(400);
      expect(detailPaths(invalid)).toEqual(['customFields.quantity']);
      expect((await api.get(`/work-logs/${created.body.id}`)).body).toEqual(created.body);

      const valid = await api.patch(`/work-logs/${created.body.id}`, {
        customFields: { area: 'Roof', quantity: 2, result: 'defect' },
      });
      expect(valid.status).toBe(200);
      expect(valid.body).toMatchObject({
        logTypeVersion: 7,
        customFields: { area: 'Roof', quantity: 2, result: 'defect' },
      });

      // An update that does not touch the custom fields leaves values and version alone.
      await ctx.prisma.logType.update({ where: { id: logType.id }, data: { version: 8 } });
      const textOnly = await api.patch(`/work-logs/${created.body.id}`, { text: 'Note' });
      expect(textOnly.body).toMatchObject({
        logTypeVersion: 7,
        customFields: valid.body.customFields,
      });
    });

    it('rejects removing the log type while custom field values remain (400), and allows it with empty values', async () => {
      const logType = await createLogType(ctx.prisma, orgId());
      const created = await api.post(
        '/work-logs',
        body({ logTypeId: logType.id, customFields: { area: 'Roof', quantity: 1 } }),
      );

      const refused = await api.patch(`/work-logs/${created.body.id}`, { logTypeId: null });
      expect(refused.status).toBe(400);
      expect(detailPaths(refused)).toEqual(['customFields']);

      const cleared = await api.patch(`/work-logs/${created.body.id}`, {
        logTypeId: null,
        customFields: {},
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({
        logTypeId: null,
        logTypeVersion: null,
        customFields: {},
      });
    });

    it('rejects an update with a future time, a bad location or a foreign reference', async () => {
      const foreignSite = await createSite(ctx.prisma, other.organization.id);
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const path = `/work-logs/${workLog.id}`;

      const future = await api.patch(path, { occurredAt: '2099-01-01T00:00:00Z' });
      expect(future.status).toBe(422);
      expect(future.body.code).toBe('occurred_at_out_of_range');
      expect((await api.patch(path, { location: { latitude: 41 } })).status).toBe(400);
      expect((await api.patch(path, { siteId: foreignSite.id })).status).toBe(422);
      expect((await api.patch(path, {})).status).toBe(400);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('rejects an update that names the author, the clientId or the status (400) and changes nothing', async () => {
      const someone = await createUser(ctx.prisma, orgId());
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id, { text: 'Old' });
      const attempts: Array<[string, unknown]> = [
        ['authorId', someone.id],
        ['clientId', randomUUID()],
        ['status', 'approved'],
        ['organizationId', other.organization.id],
        ['aiMetadata', { summary: 'x' }],
      ];

      for (const [key, value] of attempts) {
        const response = await api.patch(`/work-logs/${workLog.id}`, { text: 'x', [key]: value });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('validation_failed');
        expect(response.body.details).toContainEqual({
          path: key,
          message: 'is not a recognised field',
        });
      }

      expect(await ctx.prisma.workLog.findUniqueOrThrow({ where: { id: workLog.id } })).toEqual(
        workLog,
      );
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('changes the status and emits work_log.status_changed with from and to', async () => {
      // A reviewer approves somebody else's log (nobody approves their own).
      const author = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), author.id, 'worker');
      const workLog = await createWorkLog(ctx.prisma, orgId(), author.id);

      const response = await api.patch(`/work-logs/${workLog.id}/status`, { status: 'approved' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('approved');
      const events = await api.get('/outbox-events');
      expect(events.body.total).toBe(1);
      expect(events.body.items[0]).toMatchObject({
        eventType: 'work_log.status_changed',
        aggregateId: workLog.id,
        payload: { from: 'submitted', to: 'approved', workLog: response.body },
      });
      expect((await api.patch(`/work-logs/${workLog.id}/status`, { status: 'nope' })).status).toBe(
        400,
      );
    });

    it('records the review on reject (note required) and clears it when the log is reopened', async () => {
      const author = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), author.id, 'worker');
      const workLog = await createWorkLog(ctx.prisma, orgId(), author.id);
      const path = `/work-logs/${workLog.id}/status`;

      expect((await api.patch(path, { status: 'rejected' })).status).toBe(400);
      expect((await api.patch(path, { status: 'draft', note: 'x' })).status).toBe(400);
      const rejected = await api.patch(path, { status: 'rejected', note: 'Photo missing' });

      expect(rejected.status).toBe(200);
      expect(workLogSchema.safeParse(rejected.body).success).toBe(true);
      expect(rejected.body.review).toMatchObject({
        reviewedById: tenant.admin.id,
        note: 'Photo missing',
      });
      const events = await api.get('/outbox-events');
      expect(events.body.items[0].payload).toMatchObject({
        from: 'submitted',
        to: 'rejected',
        note: 'Photo missing',
        changedById: tenant.admin.id,
        authorId: author.id,
        reviewedById: tenant.admin.id,
      });

      const reopened = await api.patch(path, { status: 'submitted' });
      expect(reopened.status).toBe(200);
      expect(reopened.body.review).toBeNull();
      const approved = await api.patch(path, { status: 'approved' });
      expect(approved.body.review).toMatchObject({ reviewedById: tenant.admin.id, note: null });
    });

    it('archives a log; it leaves the default list and refuses later changes (409)', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);

      const archived = await api.post(`/work-logs/${workLog.id}/archive`);
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();
      expect((await api.get('/work-logs')).body.total).toBe(0);
      expect((await api.get(`/work-logs/${workLog.id}`)).status).toBe(200);

      // The author may make both changes, so the archived state is what refuses them.
      const update = await api.patch(`/work-logs/${workLog.id}`, { text: 'x' });
      const status = await api.patch(`/work-logs/${workLog.id}/status`, { status: 'draft' });
      expect([update.status, status.status]).toEqual([409, 409]);
      expect(update.body.message).toBe(`Work log ${workLog.id} is archived and cannot be changed`);
    });

    it('answers 404 for a log that does not exist', async () => {
      const id = unknownId();
      expect((await api.get(`/work-logs/${id}`)).status).toBe(404);
      expect((await api.patch(`/work-logs/${id}`, { text: 'x' })).status).toBe(404);
      expect((await api.patch(`/work-logs/${id}/status`, { status: 'draft' })).status).toBe(404);
      expect((await api.post(`/work-logs/${id}/archive`)).status).toBe(404);
    });
  });

  describe('attachments (upload flow)', () => {
    const photo = (extra: Record<string, unknown> = {}) => ({
      fileName: 'roof.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 204_800,
      ...extra,
    });

    /** Starts an upload as the admin, PUTs `bytes` through the fake storage, completes it. */
    async function uploadPhoto(workLogId: string, bytes: Uint8Array, extra = {}) {
      const started = await api.post(
        `/work-logs/${workLogId}/attachments`,
        photo({ sizeBytes: bytes.byteLength, ...extra }),
      );
      expect(started.status).toBe(201);
      ctx.storage.uploadTo(started.body.upload.url, bytes);
      const completed = await api.post(`/attachments/${started.body.attachment.id}/complete`);
      return { started, completed };
    }

    it('starts an upload (201): a pending attachment, a key chosen by the API, a signed PUT target', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      // A manager reviews the admin's log, so they may attach a photo to it.
      const uploader = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), uploader.id, 'manager', { orgWide: true });

      const response = await ctx
        .as(uploader.id)
        .post(`/work-logs/${workLog.id}/attachments`, photo({ fileName: '  ../../roof.jpg ' }));

      expect(response.status).toBe(201);
      expect(attachmentUploadSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.attachment).toMatchObject({
        organizationId: orgId(),
        workLogId: workLog.id,
        uploadedById: uploader.id,
        fileName: '../../roof.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 204_800,
        status: 'pending',
        width: null,
        height: null,
        url: null,
        thumbnailUrl: null,
        urlsExpireAt: null,
        completedAt: null,
      });
      expect(response.body.attachment).not.toHaveProperty('storageKey');
      expect(response.body.upload).toMatchObject({
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
      });
      const row = await ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: response.body.attachment.id },
      });
      expect(row.storageKey).toMatch(
        new RegExp(`^org/${orgId()}/work-logs/${workLog.id}/[0-9a-f-]{36}\\.jpg$`),
      );
      expect(ctx.storage.uploads.at(-1)).toMatchObject({
        storageKey: row.storageKey,
        mimeType: 'image/jpeg',
        sizeBytes: 204_800,
      });
      const events = await api.get('/outbox-events');
      expect(events.body.items[0]).toMatchObject({
        eventType: 'attachment.upload_started',
        payload: { attachment: response.body.attachment },
      });
    });

    it('completes an upload: verifies the image, stores a thumbnail, signs URLs; completing again changes nothing', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const bytes = await makeJpeg(80, 60);

      const { started, completed } = await uploadPhoto(workLog.id, bytes);

      expect(completed.status).toBe(200);
      expect(attachmentSchema.safeParse(completed.body).success).toBe(true);
      expect(completed.body).toMatchObject({
        id: started.body.attachment.id,
        status: 'ready',
        width: 80,
        height: 60,
      });
      expect(completed.body.completedAt).not.toBeNull();
      expect(completed.body.url).toMatch(/^fake-storage:\/\/download\//);
      expect(completed.body.thumbnailUrl).toMatch(/\.thumb\.jpg\?/);
      expect(completed.body.urlsExpireAt).not.toBeNull();
      const row = await ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: completed.body.id },
      });
      expect(row.thumbnailKey).toBe(`${row.storageKey}.thumb.jpg`);
      // The size is that of the re-encoded copy that is served, not that of the upload.
      expect(completed.body.sizeBytes).toBe(
        ctx.storage.objects.get(row.storageKey)?.body.byteLength,
      );
      const thumbnail = ctx.storage.objects.get(`${row.storageKey}.thumb.jpg`);
      expect(thumbnail?.contentType).toBe('image/jpeg');
      expect(Array.from(thumbnail?.body.slice(0, 3) ?? [])).toEqual([0xff, 0xd8, 0xff]);

      const events = await api.get('/outbox-events', { eventType: 'attachment.completed' });
      expect(events.body.total).toBe(1);
      expect(JSON.stringify(events.body.items[0].payload)).not.toContain('fake-storage');

      const again = await api.post(`/attachments/${completed.body.id}/complete`);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('ready');
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 2, outbox: 2 });
      expect((await api.get(`/attachments/${completed.body.id}`)).body.url).not.toBeNull();
    });

    it('accepts a PNG declared as PNG', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const { completed } = await uploadPhoto(workLog.id, await makePng(30, 40), {
        fileName: 'plan.png',
        mimeType: 'image/png',
      });
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({ status: 'ready', width: 30, height: 40 });
    });

    it('answers 409 when completing before the bytes arrived', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const started = await api.post(`/work-logs/${workLog.id}/attachments`, photo());
      const response = await api.post(`/attachments/${started.body.attachment.id}/complete`);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('conflict');
    });

    it.each([
      ['a PNG declared as JPEG', () => makePng(), 'type_mismatch'],
      ['a text file named .jpg', () => Promise.resolve(textBytes()), 'not_an_image'],
      ['a truncated JPEG', async () => (await makeJpeg(200, 200)).slice(0, 300), 'corrupt'],
    ])(
      'refuses %s (422): deletes the object, keeps the attachment pending',
      async (_name, make, reason) => {
        const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
        const { started, completed } = await uploadPhoto(workLog.id, await make());

        expect(completed.status).toBe(422);
        expect(completed.body).toMatchObject({
          code: 'unprocessable',
          details: [{ path: 'file', message: reason }],
        });
        const row = await ctx.prisma.attachment.findUniqueOrThrow({
          where: { id: started.body.attachment.id },
        });
        expect(row.status).toBe('pending');
        expect(ctx.storage.objects.has(row.storageKey)).toBe(false);
        expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
      },
    );

    it('refuses a declared size above UPLOAD_MAX_BYTES (400) and a stored object above it (422)', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const limit = 10 * 1024 * 1024;
      const tooLarge = await api.post(
        `/work-logs/${workLog.id}/attachments`,
        photo({ sizeBytes: limit + 1 }),
      );
      expect(tooLarge.status).toBe(400);
      expect(tooLarge.body.details).toEqual([
        { path: 'sizeBytes', message: `must be at most ${limit} bytes` },
      ]);

      const started = await api.post(`/work-logs/${workLog.id}/attachments`, photo());
      ctx.storage.uploadTo(started.body.upload.url, new Uint8Array(limit + 1));
      const completed = await api.post(`/attachments/${started.body.attachment.id}/complete`);
      expect(completed.status).toBe(422);
    });

    it('hides a pending attachment from everybody but its uploader', async () => {
      const author = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), author.id, 'worker');
      const workLog = await createWorkLog(ctx.prisma, orgId(), author.id);
      const started = await ctx
        .as(author.id)
        .post(`/work-logs/${workLog.id}/attachments`, photo({ sizeBytes: 1 }));
      const id = started.body.attachment.id;

      expect((await ctx.as(author.id).get(`/attachments/${id}`)).status).toBe(200);
      expect((await api.get(`/attachments/${id}`)).status).toBe(404);
      expect((await api.get(`/work-logs/${workLog.id}/attachments`)).body.total).toBe(0);
      expect((await api.post(`/attachments/${id}/complete`)).status).toBe(404);
      expect((await api.post(`/attachments/${id}/upload-url`)).status).toBe(404);
    });

    it('renews the upload target of a pending attachment; refuses it once ready (409)', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const started = await api.post(`/work-logs/${workLog.id}/attachments`, photo());
      const id = started.body.attachment.id;

      const renewed = await api.post(`/attachments/${id}/upload-url`);
      expect(renewed.status).toBe(200);
      expect(attachmentUploadSchema.safeParse(renewed.body).success).toBe(true);
      expect(FakeFileStorage.keyOf(renewed.body.upload.url)).toBe(
        FakeFileStorage.keyOf(started.body.upload.url),
      );

      const { completed } = await uploadPhoto(workLog.id, await makeJpeg());
      expect(completed.status).toBe(200);
      expect((await api.post(`/attachments/${completed.body.id}/upload-url`)).status).toBe(409);
    });

    it('answers 503 when the storage is unreachable, and creates nothing', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const started = await api.post(`/work-logs/${workLog.id}/attachments`, photo());
      ctx.storage.fail = true;

      const start = await api.post(`/work-logs/${workLog.id}/attachments`, photo());
      const complete = await api.post(`/attachments/${started.body.attachment.id}/complete`);
      const renew = await api.post(`/attachments/${started.body.attachment.id}/upload-url`);

      expect([start.status, complete.status, renew.status]).toEqual([503, 503, 503]);
      expect(start.body.code).toBe('service_unavailable');
      expect(await ctx.prisma.attachment.count()).toBe(1);
      // Reading does not need the storage: signing a URL makes no network call.
      expect((await api.get(`/attachments/${started.body.attachment.id}`)).status).toBe(200);
    });

    it(`refuses more than ${MAX_ATTACHMENTS_PER_WORK_LOG} attachments on one log (409)`, async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      for (let index = 0; index < MAX_ATTACHMENTS_PER_WORK_LOG; index += 1) {
        const response = await api.post(
          `/work-logs/${workLog.id}/attachments`,
          photo({ sizeBytes: 1 }),
        );
        expect(response.status).toBe(201);
      }
      const refused = await api.post(`/work-logs/${workLog.id}/attachments`, photo());
      expect(refused.status).toBe(409);
    });

    it('lists the attachments of one work log, oldest first, and sorts by name or size', async () => {
      const [first, second] = await Promise.all([
        createWorkLog(ctx.prisma, orgId(), tenant.admin.id),
        createWorkLog(ctx.prisma, orgId(), tenant.admin.id),
      ]);
      const start = (workLogId: string, extra: Record<string, unknown>) =>
        api.post(`/work-logs/${workLogId}/attachments`, photo(extra));
      await start(first.id, { fileName: 'b.jpg', sizeBytes: 1 });
      await start(first.id, { fileName: 'a.png', mimeType: 'image/png', sizeBytes: 3 });
      await start(first.id, { fileName: 'c.jpg', sizeBytes: 2 });
      await start(second.id, { fileName: 'other.jpg' });
      const fileNames = async (query: Record<string, string | number> = {}) =>
        ((await api.get(`/work-logs/${first.id}/attachments`, query)).body.items as Json[]).map(
          (item) => item.fileName,
        );

      const listed = await api.get(`/work-logs/${first.id}/attachments`);
      expect(listed.body).toMatchObject({ page: 1, pageSize: 25, total: 3 });
      expect(await fileNames()).toEqual(['b.jpg', 'a.png', 'c.jpg']);
      expect(await fileNames({ sort: 'fileName:asc' })).toEqual(['a.png', 'b.jpg', 'c.jpg']);
      expect(await fileNames({ sort: 'sizeBytes:desc' })).toEqual(['a.png', 'c.jpg', 'b.jpg']);
      expect(await fileNames({ pageSize: 2, page: 2 })).toEqual(['c.jpg']);
      expect((await api.get(`/work-logs/${second.id}/attachments`)).body.total).toBe(1);
    });

    it('archives an attachment: gone from the default list, kept with its bytes, no URLs', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const { completed } = await uploadPhoto(workLog.id, await makeJpeg());

      const archived = await api.post(`/attachments/${completed.body.id}/archive`);

      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ url: null, thumbnailUrl: null, urlsExpireAt: null });
      expect(archived.body.archivedAt).not.toBeNull();
      expect((await api.get(`/work-logs/${workLog.id}/attachments`)).body.total).toBe(0);
      expect(
        (await api.get(`/work-logs/${workLog.id}/attachments`, { includeArchived: true })).body
          .total,
      ).toBe(1);
      const row = await ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: completed.body.id },
      });
      expect(ctx.storage.objects.has(row.storageKey)).toBe(true);
    });

    it.each([
      ['a missing file name', { fileName: undefined }],
      ['a blank file name', { fileName: '   ' }],
      ['a type that is not an accepted image', { mimeType: 'application/pdf' }],
      ['HEIC (converted to JPEG on the phone)', { mimeType: 'image/heic' }],
      ['a zero size', { sizeBytes: 0 }],
      ['a negative size', { sizeBytes: -1 }],
      ['a fractional size', { sizeBytes: 1.5 }],
      ['a size sent as text', { sizeBytes: '1024' }],
      ['a storage key chosen by the client', { storageKey: 'mine/photo.jpg' }],
      ['an uploader chosen by the client', { uploadedById: randomUUID() }],
    ])('rejects %s (400)', async (_name, extra) => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id);
      const response = await api.post(`/work-logs/${workLog.id}/attachments`, photo(extra));
      expect(response.status).toBe(400);
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('answers 404 for a work log or attachment that does not exist', async () => {
      const id = unknownId();
      expect((await api.get(`/work-logs/${id}/attachments`)).status).toBe(404);
      expect((await api.post(`/work-logs/${id}/attachments`, photo())).status).toBe(404);
      expect((await api.get(`/attachments/${id}`)).status).toBe(404);
      expect((await api.post(`/attachments/${id}/complete`)).status).toBe(404);
      expect((await api.post(`/attachments/${id}/upload-url`)).status).toBe(404);
      expect((await api.post(`/attachments/${id}/archive`)).status).toBe(404);
    });

    it('refuses a new attachment on an archived work log (409)', async () => {
      const workLog = await createWorkLog(ctx.prisma, orgId(), tenant.admin.id, {
        archivedAt: at(),
      });
      const response = await api.post(`/work-logs/${workLog.id}/attachments`, photo());
      expect(response.status).toBe(409);
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });
  });
});
