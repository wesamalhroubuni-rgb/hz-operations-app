import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { healthResponseSchema } from '../health.js';
import {
  createApiTransport,
  DEFAULT_API_TIMEOUT_MS,
  healthEndpoints,
  type ApiClientOptions,
} from './client.js';
import { createApiClient } from './index.js';

const BASE_URL = 'http://api.test';
/** Any header an app adds through `getHeaders`. */
const EXTRA_HEADER = 'x-example-header';
const USER_ID = '0190f3a2-7c1e-7000-8000-000000000001';

const thingSchema = z.object({ id: z.string(), count: z.number().int() });

const ERROR_BODY = {
  statusCode: 422,
  code: 'unprocessable',
  message: 'The request refers to records that do not exist or are archived',
  details: [{ path: 'siteId', message: 'Site x does not exist in this organization' }],
  correlationId: 'corr-1',
  timestamp: '2026-10-13T10:00:00.000Z',
};

type FetchArgs = Parameters<typeof fetch>;

/** A fetch stub answering every call with a fresh copy of the given response. */
function fetchReturning(body: unknown, init: ResponseInit = {}) {
  return vi.fn<typeof fetch>(async () =>
    typeof body === 'string' || body === null
      ? new Response(body, init)
      : Response.json(body, init),
  );
}

/** A fetch stub that never answers, and rejects like the real one when its signal aborts. */
function fetchHanging() {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      }),
  );
}

function transportWith(fetchStub: typeof fetch, options: Partial<ApiClientOptions> = {}) {
  return createApiTransport({ baseUrl: BASE_URL, fetch: fetchStub, ...options });
}

function callOf(fetchStub: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  const [url, init] = fetchStub.mock.calls[index] as FetchArgs;
  return {
    url: String(url),
    init: init ?? {},
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createApiTransport: success', () => {
  it('returns the validated body and the status', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    const result = await transportWith(fetchStub).request({
      path: '/things/a',
      schema: thingSchema,
    });
    expect(result).toEqual({ ok: true, status: 200, data: { id: 'a', count: 2 } });
  });

  it('passes the status through, so a caller can tell 201 from 200', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 }, { status: 201 });
    const result = await transportWith(fetchStub).request({
      method: 'POST',
      path: '/things',
      body: { count: 2 },
      schema: thingSchema,
    });
    expect(result).toMatchObject({ ok: true, status: 201 });
  });

  it('returns the data as the schema parses it: unknown keys dropped, transforms applied', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2, secret: 'x', when: '2026-10-13' });
    const schema = thingSchema.extend({ when: z.string().transform((value) => value.slice(0, 4)) });
    const result = await transportWith(fetchStub).request({ path: '/things/a', schema });
    expect(result).toEqual({ ok: true, status: 200, data: { id: 'a', count: 2, when: '2026' } });
  });

  it('gives a schema that allows it an empty body as undefined', async () => {
    const fetchStub = fetchReturning(null, { status: 204 });
    const result = await transportWith(fetchStub).request({
      method: 'DELETE',
      path: '/things/a',
      schema: z.undefined(),
    });
    expect(result).toEqual({ ok: true, status: 204, data: undefined });
  });

  it('uses GET by default and sends no body and no Content-Type', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    await transportWith(fetchStub).request({ path: '/things/a', schema: thingSchema });
    const { url, init, headers } = callOf(fetchStub);
    expect(url).toBe('http://api.test/things/a');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(headers).toEqual({ Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to the global fetch when none is given', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    vi.stubGlobal('fetch', fetchStub);
    const transport = createApiTransport({ baseUrl: BASE_URL });
    const result = await transport.request({ path: '/things/a', schema: thingSchema });
    expect(result.ok).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('createApiTransport: alsoAccept', () => {
  const DB_DOWN = { status: 'error', database: 'down', timestamp: '2026-10-13T10:00:00.000Z' };

  it('accepts the 503 health body as data when 503 is listed', async () => {
    const fetchStub = fetchReturning(DB_DOWN, { status: 503 });
    const result = await transportWith(fetchStub).request({
      path: '/health',
      schema: healthResponseSchema,
      alsoAccept: [503],
    });
    expect(result).toEqual({ ok: true, status: 503, data: DB_DOWN });
  });

  it('health.get() accepts 503 with a health body, and calls GET /health', async () => {
    const fetchStub = fetchReturning(DB_DOWN, { status: 503 });
    const result = await healthEndpoints(transportWith(fetchStub)).get();
    expect(result).toEqual({ ok: true, status: 503, data: DB_DOWN });
    expect(callOf(fetchStub).url).toBe('http://api.test/health');
  });

  it('treats the same 503 as a failure when it is not listed', async () => {
    const fetchStub = fetchReturning(DB_DOWN, { status: 503 });
    const result = await transportWith(fetchStub).request({
      path: '/health',
      schema: healthResponseSchema,
    });
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'invalid-response', status: 503, message: 'Unexpected HTTP 503' },
    });
  });

  it('does not accept another status just because one is listed', async () => {
    const fetchStub = fetchReturning(DB_DOWN, { status: 500 });
    const result = await transportWith(fetchStub).request({
      path: '/health',
      schema: healthResponseSchema,
      alsoAccept: [503],
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'invalid-response', status: 500 } });
  });

  it('still validates an accepted status against the schema', async () => {
    const fetchStub = fetchReturning(
      { ...ERROR_BODY, statusCode: 503, code: 'service_unavailable' },
      { status: 503 },
    );
    const result = await healthEndpoints(transportWith(fetchStub)).get();
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: 'invalid-response',
        status: 503,
        message: 'The response body does not match the expected shape',
      },
    });
  });
});

describe('createApiTransport: failures', () => {
  it('turns the standard error body into an http failure carrying the parsed error', async () => {
    const fetchStub = fetchReturning(ERROR_BODY, { status: 422 });
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'http', status: 422, message: ERROR_BODY.message, error: ERROR_BODY },
    });
  });

  it.each([
    [400, 'validation_failed'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [500, 'internal_error'],
  ])('reports HTTP %i with code %s', async (status, code) => {
    const body = { ...ERROR_BODY, statusCode: status, code, details: undefined };
    const fetchStub = fetchReturning(body, { status });
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'http', status, error: { code } } });
  });

  it('accepts an error body whose correlation id is null', async () => {
    const fetchStub = fetchReturning({ ...ERROR_BODY, correlationId: null }, { status: 422 });
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'http' } });
  });

  it.each([
    ['an HTML error page', '<html><body>Bad Gateway</body></html>', 502],
    ['plain text', 'Internal Server Error', 500],
    ['truncated JSON', '{"id":"a","count":', 200],
    ['an HTML page with status 200', '<!doctype html><title>Sign in</title>', 200],
  ])('reports %s as an invalid response: not JSON', async (_name, text, status) => {
    const fetchStub = fetchReturning(text, { status });
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'invalid-response', status, message: 'The response body is not JSON' },
    });
  });

  it.each([
    ['a missing field', { id: 'a' }],
    ['a field of the wrong type', { id: 'a', count: '2' }],
    ['a list instead of an object', [{ id: 'a', count: 2 }]],
    ['null', 'null'],
    ['an error body sent with status 200', ERROR_BODY],
  ])('reports a 200 body with %s as an invalid response: wrong shape', async (_name, body) => {
    const fetchStub = fetchReturning(body);
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: 'invalid-response',
        status: 200,
        message: 'The response body does not match the expected shape',
      },
    });
  });

  it('reports an empty 200 body as the wrong shape when the schema needs one', async () => {
    const fetchStub = fetchReturning('');
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'invalid-response', status: 200 } });
  });

  it.each([
    ['JSON that is not the standard error body', { error: 'nope' }, 400],
    ['an error body with an unknown code', { ...ERROR_BODY, code: 'teapot' }, 418],
    ['an error body without a timestamp', { ...ERROR_BODY, timestamp: undefined }, 500],
    ['an empty body', '', 404],
    ['a success-shaped body', { id: 'a', count: 2 }, 500],
  ])('reports a non-2xx with %s as an unexpected status', async (_name, body, status) => {
    const fetchStub = fetchReturning(body, { status });
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'invalid-response', status, message: `Unexpected HTTP ${status}` },
    });
  });

  it('reports a rejected fetch as a network failure with its message', async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toEqual({ ok: false, failure: { kind: 'network', message: 'fetch failed' } });
  });

  it('reports a rejection that is not an Error as a network failure', async () => {
    const fetchStub = vi.fn<typeof fetch>(() => Promise.reject('offline'));
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toEqual({ ok: false, failure: { kind: 'network', message: 'Unknown error' } });
  });

  it('reports a body that breaks off while being read as a network failure', async () => {
    const fetchStub = vi.fn<typeof fetch>(
      async () =>
        ({
          status: 200,
          ok: true,
          text: () => Promise.reject(new TypeError('terminated')),
        }) as unknown as Response,
    );
    const result = await transportWith(fetchStub).request({ path: '/things', schema: thingSchema });
    expect(result).toEqual({ ok: false, failure: { kind: 'network', message: 'terminated' } });
  });

  it('reports a getHeaders that throws as a failure, without calling fetch', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    const transport = transportWith(fetchStub, {
      getHeaders: () => {
        throw new Error('no session');
      },
    });
    const result = await transport.request({ path: '/things', schema: thingSchema });
    expect(result).toEqual({ ok: false, failure: { kind: 'network', message: 'no session' } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('never throws and never rejects, whatever goes wrong', async () => {
    const outcomes = [
      fetchReturning('not json', { status: 500 }),
      fetchReturning({ wrong: true }),
      fetchReturning(ERROR_BODY, { status: 422 }),
      vi.fn<typeof fetch>(() => {
        throw new Error('synchronous failure');
      }),
      vi.fn<typeof fetch>(() => Promise.reject(new Error('asynchronous failure'))),
      vi.fn<typeof fetch>(() => Promise.reject(undefined)),
    ];
    for (const fetchStub of outcomes) {
      const call = transportWith(fetchStub).request({
        method: 'POST',
        path: '/things',
        body: { a: 1 },
        schema: thingSchema,
      });
      await expect(call).resolves.toMatchObject({ ok: false });
    }
  });
});

describe('createApiTransport: timeout', () => {
  it('gives up after the timeout, aborts the request and reports a timeout', async () => {
    vi.useFakeTimers();
    const fetchStub = fetchHanging();
    const pending = transportWith(fetchStub, { timeoutMs: 3000 }).request({
      path: '/things',
      schema: thingSchema,
    });
    let settled = false;
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    expect(callOf(fetchStub).init.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({
      ok: false,
      failure: { kind: 'timeout', message: 'No response within 3000 ms' },
    });
    expect(callOf(fetchStub).init.signal?.aborted).toBe(true);
  });

  it('uses the default timeout when none is configured', async () => {
    vi.useFakeTimers();
    const pending = transportWith(fetchHanging()).request({ path: '/things', schema: thingSchema });
    let settled = false;
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      ok: false,
      failure: { kind: 'timeout', message: `No response within ${DEFAULT_API_TIMEOUT_MS} ms` },
    });
  });

  it('lets the timeout of one request override the timeout of the client', async () => {
    vi.useFakeTimers();
    const pending = transportWith(fetchHanging(), { timeoutMs: 60_000 }).request({
      path: '/things',
      schema: thingSchema,
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({
      ok: false,
      failure: { kind: 'timeout', message: 'No response within 50 ms' },
    });
  });

  it('times out while the body is still arriving', async () => {
    vi.useFakeTimers();
    const fetchStub = vi.fn<typeof fetch>(
      async (_input, init) =>
        ({
          status: 200,
          ok: true,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        }) as unknown as Response,
    );
    const pending = transportWith(fetchStub, { timeoutMs: 100 }).request({
      path: '/things',
      schema: thingSchema,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'timeout' } });
  });

  it('clears its timer once the answer is in, on success and on failure', async () => {
    vi.useFakeTimers();
    await transportWith(fetchReturning({ id: 'a', count: 2 })).request({
      path: '/things',
      schema: thingSchema,
    });
    expect(vi.getTimerCount()).toBe(0);

    const failing = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    await transportWith(failing).request({ path: '/things', schema: thingSchema });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report a quick network error as a timeout', async () => {
    vi.useFakeTimers();
    const failing = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    const result = await transportWith(failing, { timeoutMs: 5 }).request({
      path: '/things',
      schema: thingSchema,
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'network' } });
  });
});

describe('createApiTransport: URL and query string', () => {
  async function urlFor(
    query: Record<string, string | number | boolean | null | undefined> | undefined,
    baseUrl = BASE_URL,
    path = '/things',
  ): Promise<string> {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    await transportWith(fetchStub, { baseUrl }).request({ path, query, schema: thingSchema });
    return callOf(fetchStub).url;
  }

  it('adds no question mark without a query, or with an empty one', async () => {
    expect(await urlFor(undefined)).toBe('http://api.test/things');
    expect(await urlFor({})).toBe('http://api.test/things');
  });

  it('skips undefined, null and empty-string values', async () => {
    expect(await urlFor({ a: undefined, b: null, c: '', page: 2 })).toBe(
      'http://api.test/things?page=2',
    );
    expect(await urlFor({ a: undefined, b: null, c: '' })).toBe('http://api.test/things');
  });

  it('keeps zero and false, which are values', async () => {
    expect(await urlFor({ page: 0, includeArchived: false, processed: true })).toBe(
      'http://api.test/things?page=0&includeArchived=false&processed=true',
    );
  });

  it('keeps the parameters in the order given', async () => {
    expect(await urlFor({ z: 1, a: 2, m: 3 })).toBe('http://api.test/things?z=1&a=2&m=3');
  });

  it('percent-encodes keys and values', async () => {
    expect(
      await urlFor({
        search: 'a b&c=d?e#f/g',
        sort: 'occurredAt:desc',
        from: '2026-10-13T08:00:00+03:00',
        'odd key&': 'ünï',
      }),
    ).toBe(
      'http://api.test/things?search=a%20b%26c%3Dd%3Fe%23f%2Fg&sort=occurredAt%3Adesc' +
        '&from=2026-10-13T08%3A00%3A00%2B03%3A00&odd%20key%26=%C3%BCn%C3%AF',
    );
  });

  it('produces a query string the server reads back unchanged', async () => {
    const query = { search: 'a b&c=d', from: '2026-10-13T08:00:00+03:00', action: 'task.*' };
    const url = new URL(await urlFor(query));
    expect(Object.fromEntries(url.searchParams)).toEqual(query);
  });

  it('joins the base URL and the path with exactly one slash', async () => {
    expect(await urlFor({ page: 1 }, 'http://api.test/')).toBe('http://api.test/things?page=1');
    expect(await urlFor(undefined, 'http://api.test///')).toBe('http://api.test/things');
    expect(await urlFor(undefined, 'http://api.test/v1/')).toBe('http://api.test/v1/things');
    expect(await urlFor(undefined, 'http://192.168.1.20:3001')).toBe(
      'http://192.168.1.20:3001/things',
    );
  });
});

describe('createApiTransport: headers and body', () => {
  it('sends the headers from getHeaders, such as a tracing header', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    const transport = transportWith(fetchStub, {
      getHeaders: () => ({ [EXTRA_HEADER]: USER_ID }),
    });
    await transport.request({ path: '/things', schema: thingSchema });
    expect(callOf(fetchStub).headers).toEqual({
      Accept: 'application/json',
      'x-example-header': USER_ID,
    });
  });

  it('awaits an asynchronous getHeaders', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    const transport = transportWith(fetchStub, {
      getHeaders: async () => ({ Authorization: 'Bearer example-token' }),
    });
    await transport.request({ path: '/things', schema: thingSchema });
    expect(callOf(fetchStub).headers.Authorization).toBe('Bearer example-token');
  });

  it('asks for the headers again on every request, so a changed value is picked up', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    let current = 'user-1';
    const getHeaders = vi.fn(() => ({ [EXTRA_HEADER]: current }));
    const transport = transportWith(fetchStub, { getHeaders });

    await transport.request({ path: '/things', schema: thingSchema });
    current = 'user-2';
    await transport.request({ path: '/things', schema: thingSchema });

    expect(getHeaders).toHaveBeenCalledTimes(2);
    expect(callOf(fetchStub, 0).headers[EXTRA_HEADER]).toBe('user-1');
    expect(callOf(fetchStub, 1).headers[EXTRA_HEADER]).toBe('user-2');
  });

  it('sends a JSON body with Content-Type application/json', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 }, { status: 201 });
    const body = { title: 'Fix "the" door', tags: ['a', 'b'], dueAt: null };
    await transportWith(fetchStub).request({
      method: 'POST',
      path: '/things',
      body,
      schema: thingSchema,
    });
    const { init, headers } = callOf(fetchStub);
    expect(init.method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify(body));
  });

  it.each([
    ['null', null, 'null'],
    ['false', false, 'false'],
    ['zero', 0, '0'],
    ['an empty object', {}, '{}'],
  ])('treats %s as a body: only undefined means no body', async (_name, body, sent) => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    await transportWith(fetchStub).request({
      method: 'PATCH',
      path: '/things/a',
      body,
      schema: thingSchema,
    });
    const { init, headers } = callOf(fetchStub);
    expect(init.body).toBe(sent);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does not let getHeaders drop the JSON Content-Type of a request with a body', async () => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    const transport = transportWith(fetchStub, {
      getHeaders: () => ({ 'Content-Type': 'text/plain' }),
    });
    await transport.request({ method: 'POST', path: '/things', body: {}, schema: thingSchema });
    expect(callOf(fetchStub).headers['Content-Type']).toBe('application/json');
  });

  it.each(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const)('sends method %s', async (method) => {
    const fetchStub = fetchReturning({ id: 'a', count: 2 });
    await transportWith(fetchStub).request({ method, path: '/things', schema: thingSchema });
    expect(callOf(fetchStub).init.method).toBe(method);
  });
});

describe('createApiClient', () => {
  it('routes every resource through one transport with the shared headers', async () => {
    const page = { items: [], page: 1, pageSize: 25, total: 0 };
    const fetchStub = fetchReturning(page);
    const client = createApiClient({
      baseUrl: BASE_URL,
      fetch: fetchStub,
      getHeaders: () => ({ [EXTRA_HEADER]: USER_ID }),
    });

    const result = await client.workLogs.list({
      siteId: USER_ID,
      status: 'submitted',
      occurredFrom: '2026-10-01T00:00:00Z',
      sort: 'occurredAt:desc',
      teamId: undefined,
    });

    expect(result).toEqual({ ok: true, status: 200, data: page });
    const { url, headers } = callOf(fetchStub);
    expect(url).toBe(
      `http://api.test/work-logs?siteId=${USER_ID}&status=submitted` +
        '&occurredFrom=2026-10-01T00%3A00%3A00Z&sort=occurredAt%3Adesc',
    );
    expect(headers[EXTRA_HEADER]).toBe(USER_ID);
  });

  it('exposes one endpoint group per resource', () => {
    const client = createApiClient({ baseUrl: BASE_URL, fetch: fetchReturning({}) });
    expect(Object.keys(client).sort()).toEqual([
      'attachments',
      'auditEvents',
      'auth',
      'health',
      'logTypes',
      'memberships',
      'notifications',
      'organization',
      'outboxEvents',
      'scope',
      'sites',
      'tasks',
      'teams',
      'transport',
      'users',
      'workLogs',
    ]);
  });

  it('returns the API error of a rejected write to the caller', async () => {
    const fetchStub = fetchReturning(
      { ...ERROR_BODY, statusCode: 400, code: 'validation_failed' },
      { status: 400 },
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetch: fetchStub });
    const result = await client.sites.create({ name: '' });
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'http', status: 400, error: { code: 'validation_failed' } },
    });
    expect(callOf(fetchStub).init.method).toBe('POST');
  });
});
