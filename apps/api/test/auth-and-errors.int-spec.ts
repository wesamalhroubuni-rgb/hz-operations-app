import { apiErrorSchema, DEV_USER_HEADER, REQUEST_ID_HEADER } from '@ops/shared';
import { SitesService } from '../src/operations/sites/sites.service';
import { createSite, createTenant, createUser, unknownId, type Tenant } from './support/factories';
import { startTestApp, type ApiCaller, type ApiResponse, type TestApp } from './support/test-app';

// Who may call the API in Phase 2 (the development-only acting-user header) and what every
// failure looks like on the wire.

describe('authentication and the error format', () => {
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

  /** Asserts the standard error body and returns it parsed. */
  function expectApiError(response: ApiResponse, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    const parsed = apiErrorSchema.safeParse(response.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(response.body).toMatchObject({ statusCode: status, code });
    // The correlation id is in the body and in the header, and they agree.
    expect(response.requestId).toEqual(expect.any(String));
    expect(response.body.correlationId).toBe(response.requestId);
    // Nothing but the documented fields: no stack, no "error", no internals.
    const allowed = ['code', 'correlationId', 'details', 'message', 'statusCode', 'timestamp'];
    expect(Object.keys(response.body).filter((key) => !allowed.includes(key))).toEqual([]);
    return response.body;
  }

  describe('the acting user', () => {
    it('answers 401 in the standard body, with a correlation id, when there is no header', async () => {
      const response = await ctx.as().get('/sites');
      const error = expectApiError(response, 401, 'unauthenticated');
      expect(error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(error.message).toContain(DEV_USER_HEADER);
    });

    it('echoes the correlation id of the caller in the 401', async () => {
      const response = await ctx
        .as()
        .request('GET', '/sites', { headers: { [REQUEST_ID_HEADER]: 'corr-anon-1' } });
      expect(expectApiError(response, 401, 'unauthenticated').correlationId).toBe('corr-anon-1');
    });

    it('answers 401 for a user id that does not exist', async () => {
      expectApiError(await ctx.as(unknownId()).get('/sites'), 401, 'unauthenticated');
    });

    it('answers 401 for an archived user', async () => {
      const archived = await createUser(ctx.prisma, tenant.organization.id, {
        archivedAt: new Date('2026-09-01T00:00:00Z'),
      });
      expectApiError(await ctx.as(archived.id).get('/sites'), 401, 'unauthenticated');
    });

    it('answers 401 from the moment a user is archived, and 200 again once restored', async () => {
      const user = await createUser(ctx.prisma, tenant.organization.id);
      expect((await ctx.as(user.id).get('/sites')).status).toBe(200);

      expect((await api.post(`/users/${user.id}/archive`)).status).toBe(200);
      expectApiError(await ctx.as(user.id).get('/sites'), 401, 'unauthenticated');

      expect((await api.post(`/users/${user.id}/restore`)).status).toBe(200);
      expect((await ctx.as(user.id).get('/sites')).status).toBe(200);
    });

    it.each([
      ['a value that is not a UUID', 'admin'],
      ['an email address', 'someone@example.test'],
      ['two ids in one header', `${unknownId()}, ${unknownId()}`],
      ['SQL in the header', "' OR 1=1 --"],
    ])('answers 401 for %s', async (_name, value) => {
      const response = await ctx
        .as()
        .request('GET', '/sites', { headers: { [DEV_USER_HEADER]: value } });
      expectApiError(response, 401, 'unauthenticated');
    });

    it('rejects every kind of route without a user: reads, writes and platform reads', async () => {
      const site = await createSite(ctx.prisma, tenant.organization.id);
      const anonymous = ctx.as();
      const responses = await Promise.all([
        anonymous.get('/organization'),
        anonymous.get('/users'),
        anonymous.get(`/sites/${site.id}`),
        anonymous.post('/sites', { name: 'Nope' }),
        anonymous.patch(`/sites/${site.id}`, { name: 'Nope' }),
        anonymous.post(`/sites/${site.id}/archive`),
        anonymous.get('/tasks'),
        anonymous.get('/work-logs'),
        anonymous.get('/audit-events'),
        anonymous.get('/outbox-events'),
        anonymous.get('/scope/me'),
      ]);
      for (const response of responses) {
        expectApiError(response, 401, 'unauthenticated');
      }
      const stored = await ctx.prisma.site.findMany();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ name: site.name, archivedAt: null });
      expect(await ctx.prisma.auditEvent.count()).toBe(0);
    });

    it('checks the user before the body: an anonymous invalid write is 401, not 400', async () => {
      expectApiError(await ctx.as().post('/sites', {}), 401, 'unauthenticated');
    });

    it('serves the public health route without a user', async () => {
      const response = await ctx.as().get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ok', database: 'up' });
      expect(response.requestId).toEqual(expect.any(String));
    });

    it('acts as the user of the header: the organization returned is theirs', async () => {
      const other = await createTenant(ctx.prisma, 'Other Org');
      expect((await api.get('/organization')).body.id).toBe(tenant.organization.id);
      expect((await ctx.as(other.admin.id).get('/organization')).body.id).toBe(
        other.organization.id,
      );
    });
  });

  describe('the error format', () => {
    it('unknown route: 404 not_found', async () => {
      const error = expectApiError(await api.get('/no-such-route'), 404, 'not_found');
      expect(error.details).toBeUndefined();
    });

    it('unknown route without a user: also 404, never a hint of what exists', async () => {
      expectApiError(await ctx.as().get('/no-such-route'), 404, 'not_found');
    });

    it('method that a route does not support: 404', async () => {
      const site = await createSite(ctx.prisma, tenant.organization.id);
      expectApiError(await api.delete(`/sites/${site.id}`), 404, 'not_found');
      expectApiError(await api.put(`/sites/${site.id}`, { name: 'x' }), 404, 'not_found');
      expect(await ctx.prisma.site.count()).toBe(1);
    });

    it('malformed JSON: 400 validation_failed, with the correlation id', async () => {
      const response = await api.request('POST', '/sites', {
        rawBody: '{"name": "Depot"',
        headers: { [REQUEST_ID_HEADER]: 'corr-bad-json' },
      });
      const error = expectApiError(response, 400, 'validation_failed');
      expect(error.correlationId).toBe('corr-bad-json');
      expect(await ctx.prisma.site.count()).toBe(0);
    });

    it('body that fails validation: 400 with one detail per problem, path and message', async () => {
      const response = await api.post('/sites', { name: '', latitude: 123, parentId: 'nope' });
      const error = expectApiError(response, 400, 'validation_failed');
      expect(error.message).toBe('The request is not valid');
      const paths = (error.details as Array<{ path: string; message: string }>).map(
        (detail) => detail.path,
      );
      expect(paths.sort()).toEqual(['latitude', 'name', 'parentId']);
      for (const detail of error.details) {
        expect(detail.message).toEqual(expect.any(String));
        expect(detail.message.length).toBeGreaterThan(0);
      }
    });

    it.each([
      ['an empty object', {}],
      ['a list', [{ name: 'Depot' }]],
      ['a string', 'Depot'],
      ['null', null],
    ])('body that is %s: 400', async (_name, body) => {
      const response = await api.request('POST', '/sites', { rawBody: JSON.stringify(body) });
      expectApiError(response, 400, 'validation_failed');
    });

    it('update with no field at all: 400', async () => {
      const site = await createSite(ctx.prisma, tenant.organization.id);
      const error = expectApiError(
        await api.patch(`/sites/${site.id}`, {}),
        400,
        'validation_failed',
      );
      expect(error.details[0].message).toBe('Provide at least one field to update');
    });

    it('id in the path that is not a UUID: 400, not 404 and not a database error', async () => {
      expectApiError(await api.get('/sites/123'), 400, 'validation_failed');
      expectApiError(await api.get('/users/me'), 400, 'validation_failed');
      expectApiError(await api.get("/tasks/1' OR '1'='1"), 400, 'validation_failed');
      expectApiError(
        await api.patch('/tasks/abc/status', { status: 'done' }),
        400,
        'validation_failed',
      );
      expectApiError(await api.post('/work-logs/x/archive'), 400, 'validation_failed');
    });

    it('query that fails validation: 400 naming the parameter', async () => {
      const response = await api.get('/sites', { pageSize: 500, sort: 'colour:asc', page: 0 });
      const error = expectApiError(response, 400, 'validation_failed');
      const paths = (error.details as Array<{ path: string }>).map((detail) => detail.path).sort();
      expect(paths).toEqual(['page', 'pageSize', 'sort']);
    });

    it('record that does not exist: 404 not_found naming the record', async () => {
      const id = unknownId();
      const error = expectApiError(await api.get(`/sites/${id}`), 404, 'not_found');
      expect(error.message).toBe(`Site ${id} was not found`);
    });

    it('rule broken by a well-formed request: 422 unprocessable with details', async () => {
      const id = unknownId();
      const error = expectApiError(
        await api.post('/sites', { name: 'Yard', parentId: id }),
        422,
        'unprocessable',
      );
      expect(error.details).toEqual([
        {
          path: 'parentId',
          message: `Site ${id} does not exist in this organization or is archived`,
        },
      ]);
    });

    it('conflict with the current state: 409 conflict', async () => {
      const site = await createSite(ctx.prisma, tenant.organization.id, {
        archivedAt: new Date('2026-09-01T00:00:00Z'),
      });
      const error = expectApiError(
        await api.patch(`/sites/${site.id}`, { name: 'Renamed' }),
        409,
        'conflict',
      );
      expect(error.message).toContain('archived');
    });

    it('unexpected failure: 500 internal_error that reveals nothing', async () => {
      jest
        .spyOn(ctx.app.get(SitesService), 'list')
        .mockRejectedValueOnce(
          new Error('connect to postgresql://ops:example-secret@db:5432/app failed'),
        );
      const response = await api.get('/sites');
      const error = expectApiError(response, 500, 'internal_error');
      expect(error.message).toBe('Internal server error');
      expect(response.text).not.toContain('example-secret');
      expect(response.text).not.toContain('postgresql');
      expect(response.text).not.toContain('stack');
    });

    it('request body over the size limit: 413 in the standard body', async () => {
      const response = await api.post('/sites', { name: 'x', description: 'x'.repeat(200_000) });
      expect(response.status).toBe(413);
      expect(apiErrorSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.correlationId).toBe(response.requestId);
    });

    it('timestamp of an error is the time of the response', async () => {
      const before = Date.now();
      const error = expectApiError(await api.get('/no-such-route'), 404, 'not_found');
      const stamped = new Date(error.timestamp).getTime();
      expect(stamped).toBeGreaterThanOrEqual(before - 1000);
      expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe('the correlation id', () => {
    it('is echoed on success too, and generated when the caller sends none', async () => {
      const echoed = await api.request('GET', '/sites', {
        headers: { [REQUEST_ID_HEADER]: 'corr-ok-1' },
      });
      expect(echoed.status).toBe(200);
      expect(echoed.requestId).toBe('corr-ok-1');

      const generated = await api.get('/sites');
      expect(generated.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect((await api.get('/sites')).requestId).not.toBe(generated.requestId);
    });

    it.each([
      ['too long', 'a'.repeat(65)],
      ['with a space', 'has space'],
      ['with markup', '<script>alert(1)</script>'],
      ['with JSON', '{"a":1}'],
    ])('replaces an unusable value (%s) with a new id', async (_name, value) => {
      const response = await api.request('GET', '/no-such-route', {
        headers: { [REQUEST_ID_HEADER]: value },
      });
      expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.body.correlationId).toBe(response.requestId);
    });
  });
});
