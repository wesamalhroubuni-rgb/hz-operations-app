import { describe, expect, it, vi } from 'vitest';

import type { AuthTokens } from '../platform/auth.js';
import {
  createAuthSessionManager,
  setPasswordFailure,
  signInFailureReason,
  type AuthSessionManager,
  type TokenStorage,
} from './auth-session.js';
import { AUTH_FAILURE_MESSAGES, AUTH_TEXT } from './auth-text.js';
import type { ApiFailure } from './client.js';

const BASE_URL = 'http://api.test';
const NOW = '2026-10-13T10:00:00.000Z';
const LATER = '2026-11-12T10:00:00.000Z';
const PASSWORD = 'correct horse battery';
const CODE = 'ABCD-EFGH-JKLM';

const USER = {
  id: '0190f3a2-7c1e-7000-8000-000000000001',
  organizationId: '0190f3a2-7c1e-7000-8000-000000000002',
  organizationName: 'Example Org',
  displayName: 'Sam Supervisor',
  email: 'sam@example.test',
  phone: null,
  username: null,
  roles: ['supervisor', 'worker'],
  role: 'supervisor',
};
const SESSION = { id: '0190f3a2-7c1e-7000-8000-000000000003', expiresAt: LATER };

function tokenPair(name: string): AuthTokens {
  return {
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    refreshTokenExpiresAt: LATER,
  };
}

const webGrant = (csrfToken: string) => ({
  session: SESSION,
  accessTokenExpiresAt: NOW,
  tokens: null,
  csrfToken,
});
const mobileGrant = (name: string) => ({
  session: SESSION,
  accessTokenExpiresAt: NOW,
  tokens: tokenPair(name),
  csrfToken: null,
});

const ok = (body: unknown) => () => Response.json(body);
const problem =
  (status: number, code: string, details?: { path: string; message: string }[]) => () =>
    Response.json(
      {
        statusCode: status,
        code,
        message: 'Refused',
        details,
        correlationId: null,
        timestamp: NOW,
      },
      { status },
    );
const offline = () => {
  throw new TypeError('fetch failed');
};
const UNAUTHENTICATED = problem(401, 'unauthenticated');

interface Call {
  route: string;
  headers: Record<string, string>;
  body: unknown;
  credentials: string | undefined;
}
type Handler = (call: Call) => Response | Promise<Response>;

/**
 * A stub of the API. Each route answers with its handler; a list of handlers is used in order
 * and the last one repeats. An unlisted route fails the test loudly.
 */
function fakeApi(routes: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const used: Record<string, number> = {};
  const fetchStub = vi.fn<typeof fetch>(async (input, init) => {
    const route = `${init?.method ?? 'GET'} ${String(input).replace(BASE_URL, '')}`;
    const call: Call = {
      route,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init?.credentials,
    };
    calls.push(call);
    const entry = routes[route];
    if (entry === undefined) {
      throw new Error(`Unexpected request in test: ${route}`);
    }
    const list = Array.isArray(entry) ? entry : [entry];
    const index = Math.min(used[route] ?? 0, list.length - 1);
    used[route] = (used[route] ?? 0) + 1;
    return (list[index] as Handler)(call);
  });
  return {
    fetch: fetchStub as typeof fetch,
    calls,
    count: (route: string) => calls.filter((call) => call.route === route).length,
    last: (route: string) => calls.filter((call) => call.route === route).at(-1) as Call,
  };
}

function memoryStorage(initial: AuthTokens | null = null) {
  let stored = initial;
  const log: string[] = [];
  const storage: TokenStorage = {
    load: vi.fn(async () => stored),
    save: vi.fn(async (next: AuthTokens) => {
      stored = next;
      log.push(`save ${next.accessToken}`);
    }),
    clear: vi.fn(async () => {
      stored = null;
      log.push('clear');
    }),
  };
  return { storage, log, current: () => stored };
}

function webSession(api: ReturnType<typeof fakeApi>): AuthSessionManager {
  return createAuthSessionManager({ baseUrl: BASE_URL, mode: 'web', fetch: api.fetch });
}

function mobileSession(api: ReturnType<typeof fakeApi>, storage: TokenStorage): AuthSessionManager {
  return createAuthSessionManager({
    baseUrl: BASE_URL,
    mode: 'mobile',
    storage,
    deviceName: 'Test phone',
    fetch: api.fetch,
  });
}

const ME_WEB = ok({ user: USER, session: SESSION, csrfToken: 'csrf-1' });
const ME_MOBILE = ok({ user: USER, session: SESSION, csrfToken: null });
const SESSIONS = ok({ items: [] });

describe('web: start-up', () => {
  it('starts in loading and becomes signed in when the cookie session answers', async () => {
    const api = fakeApi({ 'GET /auth/me': ME_WEB });
    const session = webSession(api);
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getState().status));

    expect(session.getState()).toEqual({ status: 'loading' });
    await session.start();

    expect(session.getState()).toEqual({ status: 'signedIn', user: USER });
    expect(seen).toEqual(['loading', 'signedIn']);
    expect(api.last('GET /auth/me').credentials).toBe('include');
    expect(api.last('GET /auth/me').headers.Authorization).toBeUndefined();
  });

  it('recovers the CSRF token from /auth/me and sends it on state-changing requests only', async () => {
    const api = fakeApi({
      'GET /auth/me': ME_WEB,
      'GET /auth/sessions': SESSIONS,
      'POST /auth/logout-all': ok({}),
    });
    const session = webSession(api);
    await session.start();

    await session.client.auth.sessions();
    await session.signOutEverywhere();

    expect(api.last('GET /auth/sessions').headers['x-csrf-token']).toBeUndefined();
    expect(api.last('POST /auth/logout-all').headers['x-csrf-token']).toBe('csrf-1');
  });

  it('is signed out without a notice when there is no session, after exactly one refresh', async () => {
    const api = fakeApi({ 'GET /auth/me': UNAUTHENTICATED, 'POST /auth/refresh': UNAUTHENTICATED });
    const session = webSession(api);

    await session.start();

    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
    expect(api.count('GET /auth/me')).toBe(1);
    expect(api.count('POST /auth/refresh')).toBe(1);
    expect(api.last('POST /auth/refresh').body).toEqual({});
  });

  it('renews an expired access cookie on the way and uses the new CSRF token', async () => {
    const api = fakeApi({
      'GET /auth/me': [UNAUTHENTICATED, ok({ user: USER, session: SESSION, csrfToken: 'csrf-2' })],
      'POST /auth/refresh': ok(webGrant('csrf-2')),
      'POST /auth/logout': ok({}),
    });
    const session = webSession(api);

    await session.start();
    expect(session.getState().status).toBe('signedIn');

    await session.signOut();
    expect(api.last('POST /auth/logout').headers['x-csrf-token']).toBe('csrf-2');
  });

  it('reports an unreachable server and can be started again', async () => {
    const api = fakeApi({ 'GET /auth/me': [offline, ME_WEB] });
    const session = webSession(api);

    await session.start();
    expect(session.getState()).toEqual({ status: 'signedOut', notice: 'unreachable' });

    await session.start();
    expect(session.getState().status).toBe('signedIn');
  });

  it('treats a server error at start as unreachable, not as signed in', async () => {
    const api = fakeApi({ 'GET /auth/me': problem(500, 'internal_error') });
    const session = webSession(api);
    await session.start();
    expect(session.getState()).toEqual({ status: 'signedOut', notice: 'unreachable' });
  });

  it('shares one check between overlapping start() calls', async () => {
    const api = fakeApi({ 'GET /auth/me': ME_WEB });
    const session = webSession(api);
    await Promise.all([session.start(), session.start()]);
    expect(api.count('GET /auth/me')).toBe(1);
  });
});

describe('sign-in', () => {
  it('web: sends the trimmed identifier as a web client and becomes signed in', async () => {
    const api = fakeApi({
      'POST /auth/login': ok({ user: USER, ...webGrant('csrf-9') }),
      'POST /auth/logout': ok({}),
    });
    const session = webSession(api);

    const result = await session.signIn('  sam@example.test ', PASSWORD);

    expect(result).toEqual({ ok: true });
    expect(session.getState()).toEqual({ status: 'signedIn', user: USER });
    expect(api.last('POST /auth/login').body).toEqual({
      identifier: 'sam@example.test',
      password: PASSWORD,
      client: 'web',
    });
    expect(api.last('POST /auth/login').credentials).toBe('include');

    await session.signOut();
    expect(api.last('POST /auth/logout').headers['x-csrf-token']).toBe('csrf-9');
  });

  it('sends the organization slug when the deployment configures one', async () => {
    const api = fakeApi({ 'POST /auth/login': ok({ user: USER, ...webGrant('c') }) });
    const session = createAuthSessionManager({
      baseUrl: BASE_URL,
      mode: 'web',
      fetch: api.fetch,
      organizationSlug: 'example',
    });
    await session.signIn('sam', PASSWORD);
    expect(api.last('POST /auth/login').body).toMatchObject({ organizationSlug: 'example' });
  });

  it('mobile: stores the tokens, names the device and uses the bearer token afterwards', async () => {
    const api = fakeApi({
      'POST /auth/login': ok({ user: USER, ...mobileGrant('a') }),
      'GET /auth/sessions': SESSIONS,
    });
    const { storage, current } = memoryStorage();
    const session = mobileSession(api, storage);

    expect(await session.signIn('0501234567', PASSWORD)).toEqual({ ok: true });

    expect(api.last('POST /auth/login').body).toEqual({
      identifier: '0501234567',
      password: PASSWORD,
      client: 'mobile',
      deviceName: 'Test phone',
    });
    expect(api.last('POST /auth/login').credentials).toBe('omit');
    expect(current()).toEqual(tokenPair('a'));

    await session.client.auth.sessions();
    expect(api.last('GET /auth/sessions').headers.Authorization).toBe('Bearer access-a');
    expect(api.last('GET /auth/sessions').headers['x-csrf-token']).toBeUndefined();
  });

  it('mobile: refuses an answer without tokens instead of pretending to be signed in', async () => {
    const api = fakeApi({ 'POST /auth/login': ok({ user: USER, ...webGrant('c') }) });
    const session = mobileSession(api, memoryStorage().storage);
    const result = await session.signIn('sam', PASSWORD);
    expect(result).toMatchObject({ ok: false, failure: { reason: 'unexpected' } });
    expect(session.getState().status).not.toBe('signedIn');
  });

  it('mobile: stays signed in from memory when the tokens cannot be stored', async () => {
    const api = fakeApi({ 'POST /auth/login': ok({ user: USER, ...mobileGrant('a') }) });
    const { storage } = memoryStorage();
    storage.save = vi.fn(async () => {
      throw new Error('keystore unavailable');
    });
    const session = mobileSession(api, storage);
    expect(await session.signIn('sam', PASSWORD)).toEqual({ ok: true });
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(session.getState().status).toBe('signedIn');
  });

  it.each([
    ['a wrong password or a locked account (401)', UNAUTHENTICATED, 'invalid_credentials'],
    ['an origin the API refuses (403)', problem(403, 'forbidden'), 'unexpected'],
    [
      'an identifier the API will not look up (400)',
      problem(400, 'validation_failed'),
      'invalid_credentials',
    ],
    ['too many attempts (429)', problem(429, 'rate_limited'), 'rate_limited'],
    ['no connection', offline, 'network'],
    ['a server error', problem(500, 'internal_error'), 'unexpected'],
    ['a body that is not the contract', ok({ nope: true }), 'unexpected'],
  ] as const)('maps %s to one reason and its message', async (_name, handler, reason) => {
    const api = fakeApi({ 'POST /auth/login': handler });
    const session = webSession(api);

    const result = await session.signIn('sam@example.test', PASSWORD);

    expect(result).toEqual({
      ok: false,
      failure: { reason, message: AUTH_FAILURE_MESSAGES[reason], details: [] },
    });
    expect(session.getState().status).not.toBe('signedIn');
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    // Sign-in is never retried through a refresh.
    expect(api.calls).toHaveLength(1);
  });

  it('says "too many attempts, try again later" for a rate limit', () => {
    expect(AUTH_FAILURE_MESSAGES.rate_limited).toBe('Too many attempts. Try again later.');
  });

  it.each([
    ['', PASSWORD],
    ['   ', PASSWORD],
    ['sam', ''],
  ])(
    'does not call the API with an empty field (%j, password given: %#)',
    async (identifier, password) => {
      const api = fakeApi({});
      const result = await webSession(api).signIn(identifier, password);
      expect(result).toMatchObject({ ok: false, failure: { reason: 'missing_fields' } });
      expect(api.calls).toHaveLength(0);
    },
  );
});

describe('mobile: start-up', () => {
  it('is signed out without calling the API when nothing is stored', async () => {
    const api = fakeApi({});
    const session = mobileSession(api, memoryStorage().storage);
    await session.start();
    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
    expect(api.calls).toHaveLength(0);
  });

  it('loads the stored tokens and asks who the user is with the bearer token', async () => {
    const api = fakeApi({ 'GET /auth/me': ME_MOBILE });
    const session = mobileSession(api, memoryStorage(tokenPair('a')).storage);

    await session.start();

    expect(session.getState()).toEqual({ status: 'signedIn', user: USER });
    expect(api.last('GET /auth/me').headers.Authorization).toBe('Bearer access-a');
    expect(api.last('GET /auth/me').credentials).toBe('omit');
  });

  it('is signed out when the storage cannot be read', async () => {
    const api = fakeApi({});
    const { storage } = memoryStorage(tokenPair('a'));
    storage.load = vi.fn(async () => {
      throw new Error('keystore unavailable');
    });
    const session = mobileSession(api, storage);
    await session.start();
    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
  });

  it('keeps the stored tokens when the server cannot be reached', async () => {
    const api = fakeApi({ 'GET /auth/me': [offline, ME_MOBILE] });
    const { storage, current } = memoryStorage(tokenPair('a'));
    const session = mobileSession(api, storage);

    await session.start();
    expect(session.getState()).toEqual({ status: 'signedOut', notice: 'unreachable' });
    expect(storage.clear).not.toHaveBeenCalled();
    expect(current()).toEqual(tokenPair('a'));

    await session.start();
    expect(session.getState().status).toBe('signedIn');
  });

  it('renews an expired access token at start and stores the rotated pair', async () => {
    const api = fakeApi({
      'GET /auth/me': [UNAUTHENTICATED, ME_MOBILE],
      'POST /auth/refresh': ok(mobileGrant('b')),
    });
    const { storage, current } = memoryStorage(tokenPair('a'));
    const session = mobileSession(api, storage);

    await session.start();

    expect(session.getState().status).toBe('signedIn');
    expect(api.last('POST /auth/refresh').body).toEqual({ refreshToken: 'refresh-a' });
    expect(api.last('GET /auth/me').headers.Authorization).toBe('Bearer access-b');
    expect(current()).toEqual(tokenPair('b'));
  });

  it('says the session ended, and clears the storage, when the stored tokens are refused', async () => {
    const api = fakeApi({ 'GET /auth/me': UNAUTHENTICATED, 'POST /auth/refresh': UNAUTHENTICATED });
    const { storage, current } = memoryStorage(tokenPair('a'));
    const session = mobileSession(api, storage);

    await session.start();

    expect(session.getState()).toEqual({ status: 'signedOut', notice: 'session_expired' });
    await vi.waitFor(() => expect(current()).toBeNull());
  });
});

async function signedInMobile(routes: Record<string, Handler | Handler[]>) {
  const api = fakeApi({ 'POST /auth/login': ok({ user: USER, ...mobileGrant('a') }), ...routes });
  const memory = memoryStorage();
  const session = mobileSession(api, memory.storage);
  await session.signIn('sam', PASSWORD);
  return { api, session, ...memory };
}

async function signedInWeb(routes: Record<string, Handler | Handler[]>) {
  const api = fakeApi({ 'POST /auth/login': ok({ user: USER, ...webGrant('csrf-1') }), ...routes });
  const session = webSession(api);
  await session.signIn('sam', PASSWORD);
  return { api, session };
}

describe('refresh', () => {
  it('mobile: renews once on a 401, stores the new pair, and repeats the request with it', async () => {
    const { api, session, current } = await signedInMobile({
      'GET /auth/sessions': [UNAUTHENTICATED, SESSIONS],
      'POST /auth/refresh': ok(mobileGrant('b')),
    });

    const result = await session.client.auth.sessions();

    expect(result.ok).toBe(true);
    expect(api.count('POST /auth/refresh')).toBe(1);
    expect(api.last('POST /auth/refresh').body).toEqual({ refreshToken: 'refresh-a' });
    // The refresh call itself carries no CSRF token and is not retried through another refresh.
    expect(api.last('GET /auth/sessions').headers.Authorization).toBe('Bearer access-b');
    expect(current()).toEqual(tokenPair('b'));
    expect(session.getState().status).toBe('signedIn');
  });

  it('mobile: the rotated pair is in storage before anything uses it', async () => {
    const { api, session, storage } = await signedInMobile({
      'GET /auth/sessions': [UNAUTHENTICATED, SESSIONS],
      'POST /auth/refresh': ok(mobileGrant('b')),
    });
    let finishSave: () => void = () => {};
    storage.save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );

    const pending = session.client.auth.sessions();
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledWith(tokenPair('b')));

    // The write has not finished: the request must not have been repeated yet.
    expect(api.count('GET /auth/sessions')).toBe(1);

    finishSave();
    await pending;
    expect(api.count('GET /auth/sessions')).toBe(2);
    expect(api.last('GET /auth/sessions').headers.Authorization).toBe('Bearer access-b');
  });

  it('mobile: carries on from memory when the rotated pair cannot be stored', async () => {
    const { session, storage } = await signedInMobile({
      'GET /auth/sessions': [UNAUTHENTICATED, SESSIONS],
      'POST /auth/refresh': ok(mobileGrant('b')),
    });
    storage.save = vi.fn(async () => {
      throw new Error('keystore unavailable');
    });
    expect((await session.client.auth.sessions()).ok).toBe(true);
    expect(session.getState().status).toBe('signedIn');
  });

  it('mobile: a refused refresh signs out and clears the storage', async () => {
    const { api, session, storage, current } = await signedInMobile({
      'GET /auth/sessions': UNAUTHENTICATED,
      'POST /auth/refresh': UNAUTHENTICATED,
    });

    const result = await session.client.auth.sessions();

    expect(result).toMatchObject({ ok: false, failure: { kind: 'http', status: 401 } });
    expect(session.getState()).toEqual({ status: 'signedOut', notice: 'session_expired' });
    await vi.waitFor(() => expect(storage.clear).toHaveBeenCalled());
    expect(current()).toBeNull();
    // One request, one refresh, nothing more.
    expect(api.count('GET /auth/sessions')).toBe(1);
    expect(api.count('POST /auth/refresh')).toBe(1);

    // Signed out means signed out: later requests carry no token and do not try to refresh.
    await session.client.auth.sessions();
    expect(api.last('GET /auth/sessions').headers.Authorization).toBeUndefined();
    expect(api.count('POST /auth/refresh')).toBe(1);
  });

  it('web: a refused refresh signs out', async () => {
    const { session } = await signedInWeb({
      'GET /auth/sessions': UNAUTHENTICATED,
      'POST /auth/refresh': UNAUTHENTICATED,
    });
    await session.client.auth.sessions();
    expect(session.getState()).toEqual({ status: 'signedOut', notice: 'session_expired' });
  });

  it('web: a renewed session picks up the new CSRF token for the repeated request', async () => {
    const { api, session } = await signedInWeb({
      'POST /auth/change-password': [UNAUTHENTICATED, ok({})],
      'POST /auth/refresh': ok(webGrant('csrf-2')),
    });

    await session.client.auth.changePassword({ currentPassword: PASSWORD, newPassword: PASSWORD });

    const attempts = api.calls.filter((call) => call.route === 'POST /auth/change-password');
    expect(attempts.map((call) => call.headers['x-csrf-token'])).toEqual(['csrf-1', 'csrf-2']);
    expect(api.last('POST /auth/refresh').body).toEqual({});
  });

  it('does not throw the session away when the refresh merely could not reach the server', async () => {
    const { session, storage, current } = await signedInMobile({
      'GET /auth/sessions': UNAUTHENTICATED,
      'POST /auth/refresh': offline,
    });

    const result = await session.client.auth.sessions();

    expect(result.ok).toBe(false);
    expect(session.getState().status).toBe('signedIn');
    expect(storage.clear).not.toHaveBeenCalled();
    expect(current()).toEqual(tokenPair('a'));
  });

  it.each([
    ['rate limited', problem(429, 'rate_limited')],
    ['a server error', problem(500, 'internal_error')],
    ['refused for its origin', problem(403, 'forbidden')],
  ])('keeps the session when the refresh is %s', async (_name, handler) => {
    const { session } = await signedInMobile({
      'GET /auth/sessions': UNAUTHENTICATED,
      'POST /auth/refresh': handler,
    });
    await session.client.auth.sessions();
    expect(session.getState().status).toBe('signedIn');
  });

  it('is single flight: concurrent 401s share one refresh', async () => {
    const { api, session } = await signedInMobile({
      'GET /auth/sessions': (call) =>
        call.headers.Authorization === 'Bearer access-b' ? SESSIONS() : UNAUTHENTICATED(),
      'GET /auth/me': (call) =>
        call.headers.Authorization === 'Bearer access-b' ? ME_MOBILE() : UNAUTHENTICATED(),
      'POST /auth/refresh': async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return ok(mobileGrant('b'))();
      },
    });

    const results = await Promise.all([
      session.client.auth.sessions(),
      session.client.auth.sessions(),
      session.client.auth.me(),
      session.client.auth.sessions(),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(api.count('POST /auth/refresh')).toBe(1);
    expect(session.getState().status).toBe('signedIn');
  });

  it('does not loop: a 401 right after a successful refresh is final', async () => {
    const { api, session, current } = await signedInMobile({
      'GET /auth/sessions': UNAUTHENTICATED,
      'POST /auth/refresh': ok(mobileGrant('b')),
    });

    const result = await session.client.auth.sessions();

    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
    expect(api.count('GET /auth/sessions')).toBe(2);
    expect(api.count('POST /auth/refresh')).toBe(1);
    expect(session.getState()).toEqual({ status: 'signedOut', notice: 'session_expired' });
    await vi.waitFor(() => expect(current()).toBeNull());
  });

  it('a refresh that answers after sign-out does not bring the session back', async () => {
    let answerRefresh: (response: Response) => void = () => {};
    const { api, session, current } = await signedInMobile({
      'GET /auth/sessions': UNAUTHENTICATED,
      'POST /auth/refresh': () =>
        new Promise<Response>((resolve) => {
          answerRefresh = resolve;
        }),
      'POST /auth/logout': ok({}),
    });

    const pending = session.client.auth.sessions();
    await vi.waitFor(() => expect(api.count('POST /auth/refresh')).toBe(1));
    await session.signOut();
    answerRefresh(ok(mobileGrant('b'))());
    await pending;

    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
    expect(current()).toBeNull();
  });
});

describe('sign-out', () => {
  it('mobile: tells the server, clears the storage and is signed out', async () => {
    const { api, session, current } = await signedInMobile({ 'POST /auth/logout': ok({}) });

    expect(await session.signOut()).toEqual({ ok: true });

    expect(api.last('POST /auth/logout').headers.Authorization).toBe('Bearer access-a');
    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
    expect(current()).toBeNull();
  });

  it.each([
    ['the network is down', offline],
    ['the server fails', problem(500, 'internal_error')],
  ])(
    'clears the local session even when %s, and says it is unconfirmed',
    async (_name, handler) => {
      const { session, current } = await signedInMobile({ 'POST /auth/logout': handler });

      expect(await session.signOut()).toEqual({ ok: true });

      expect(session.getState()).toEqual({ status: 'signedOut', notice: 'sign_out_unconfirmed' });
      expect(current()).toBeNull();
    },
  );

  it('is signed out even when the storage cannot be cleared', async () => {
    const { session, storage } = await signedInMobile({ 'POST /auth/logout': ok({}) });
    storage.clear = vi.fn(async () => {
      throw new Error('keystore unavailable');
    });
    await session.signOut();
    expect(session.getState().status).toBe('signedOut');
  });

  it('with an expired access token: renews once, then signs out for real', async () => {
    const { api, session } = await signedInWeb({
      'POST /auth/logout': [UNAUTHENTICATED, ok({})],
      'POST /auth/refresh': ok(webGrant('csrf-2')),
    });

    await session.signOut();

    expect(api.count('POST /auth/logout')).toBe(2);
    expect(api.count('POST /auth/refresh')).toBe(1);
    expect(api.last('POST /auth/logout').headers['x-csrf-token']).toBe('csrf-2');
    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
  });

  it('with a session that is already gone: signed out, confirmed, no loop', async () => {
    const { api, session } = await signedInWeb({
      'POST /auth/logout': UNAUTHENTICATED,
      'POST /auth/refresh': UNAUTHENTICATED,
    });
    await session.signOut();
    expect(api.count('POST /auth/logout')).toBe(1);
    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
  });

  it('everywhere: signs out when the server confirms', async () => {
    const { api, session, current } = await signedInMobile({ 'POST /auth/logout-all': ok({}) });
    expect(await session.signOutEverywhere()).toEqual({ ok: true });
    expect(api.count('POST /auth/logout-all')).toBe(1);
    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
    expect(current()).toBeNull();
  });

  it('everywhere: stays signed in and reports it when the server could not confirm', async () => {
    const { session, current } = await signedInMobile({ 'POST /auth/logout-all': offline });
    expect(await session.signOutEverywhere()).toMatchObject({
      ok: false,
      failure: { reason: 'network' },
    });
    expect(session.getState().status).toBe('signedIn');
    expect(current()).toEqual(tokenPair('a'));
  });

  it('everywhere: a session that was already gone counts as signed out', async () => {
    const { session } = await signedInWeb({
      'POST /auth/logout-all': UNAUTHENTICATED,
      'POST /auth/refresh': UNAUTHENTICATED,
    });
    expect(await session.signOutEverywhere()).toEqual({ ok: true });
    expect(session.getState().status).toBe('signedOut');
  });
});

describe('set password', () => {
  it('sends the trimmed code and the password, and does not sign in', async () => {
    const api = fakeApi({ 'POST /auth/set-password': ok({}) });
    const session = webSession(api);

    expect(await session.setPassword(`  ${CODE} `, PASSWORD)).toEqual({ ok: true });

    expect(api.last('POST /auth/set-password').body).toEqual({ code: CODE, password: PASSWORD });
    expect(session.getState().status).not.toBe('signedIn');
  });

  it('accepts an empty success body', async () => {
    const api = fakeApi({ 'POST /auth/set-password': () => new Response(null, { status: 204 }) });
    expect(await webSession(api).setPassword(CODE, PASSWORD)).toEqual({ ok: true });
  });

  it('checks the length policy before calling the API', async () => {
    const api = fakeApi({});
    const result = await webSession(api).setPassword(CODE, 'short');
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'weak_password', message: AUTH_TEXT.passwordTooShort, details: [] },
    });
    expect(api.calls).toHaveLength(0);
  });

  it('does not call the API without a code', async () => {
    const api = fakeApi({});
    const result = await webSession(api).setPassword('  ', PASSWORD);
    expect(result).toMatchObject({ ok: false, failure: { reason: 'invalid_code' } });
    expect(api.calls).toHaveLength(0);
  });

  it.each([
    ['400', problem(400, 'validation_failed', [{ path: 'code', message: 'is not valid' }])],
    ['422, the answer of the API', problem(422, 'unprocessable')],
    ['404', problem(404, 'not_found')],
  ])('reports an expired or invalid code (%s)', async (_name, handler) => {
    const api = fakeApi({ 'POST /auth/set-password': handler });
    const result = await webSession(api).setPassword(CODE, PASSWORD);
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'invalid_code',
        message: AUTH_FAILURE_MESSAGES.invalid_code,
        details: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(api.calls).toHaveLength(1);
  });

  it("reports a weak password with the server's details", async () => {
    const details = [
      { path: 'password', message: 'must not contain your username' },
      { path: 'password', message: 'is too common' },
    ];
    const api = fakeApi({ 'POST /auth/set-password': problem(400, 'validation_failed', details) });
    const result = await webSession(api).setPassword(CODE, PASSWORD);
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'weak_password',
        message: AUTH_FAILURE_MESSAGES.weak_password,
        details: ['The password must not contain your username.', 'The password is too common.'],
      },
    });
  });

  it.each([
    ['too many attempts', problem(429, 'rate_limited'), 'rate_limited'],
    ['no connection', offline, 'network'],
    ['a server error', problem(500, 'internal_error'), 'unexpected'],
    ['an origin the API refuses (403)', problem(403, 'forbidden'), 'unexpected'],
  ] as const)('reports %s', async (_name, handler, reason) => {
    const api = fakeApi({ 'POST /auth/set-password': handler });
    const result = await webSession(api).setPassword(CODE, PASSWORD);
    expect(result).toMatchObject({ ok: false, failure: { reason } });
  });
});

describe('sign-out names the session by its refresh token (mobile)', () => {
  it('sends { refreshToken } of the current pair in the logout body', async () => {
    const { api, session } = await signedInMobile({ 'POST /auth/logout': ok({}) });
    await session.signOut();
    expect(api.last('POST /auth/logout').body).toEqual({ refreshToken: 'refresh-a' });
  });

  it('sends the rotated refresh token after a renewal, never the used one', async () => {
    const { api, session } = await signedInMobile({
      'GET /auth/sessions': [UNAUTHENTICATED, SESSIONS],
      'POST /auth/refresh': ok(mobileGrant('b')),
      'POST /auth/logout': ok({}),
    });
    await session.client.auth.sessions();
    await session.signOut();
    expect(api.last('POST /auth/logout').body).toEqual({ refreshToken: 'refresh-b' });
    expect(api.last('POST /auth/logout').headers.Authorization).toBe('Bearer access-b');
  });

  it('with an expired access token: renews once and repeats the logout with the new token', async () => {
    const { api, session, current } = await signedInMobile({
      'POST /auth/logout': [UNAUTHENTICATED, ok({})],
      'POST /auth/refresh': ok(mobileGrant('b')),
    });
    await session.signOut();
    const bodies = api.calls
      .filter((call) => call.route === 'POST /auth/logout')
      .map((call) => call.body);
    expect(bodies).toEqual([{ refreshToken: 'refresh-a' }, { refreshToken: 'refresh-b' }]);
    expect(api.count('POST /auth/refresh')).toBe(1);
    expect(session.getState()).toEqual({ status: 'signedOut', notice: null });
    expect(current()).toBeNull();
  });

  it('web: sends no body at all (the cookies name the session)', async () => {
    const { api, session } = await signedInWeb({ 'POST /auth/logout': ok({}) });
    await session.signOut();
    expect(api.last('POST /auth/logout').body).toBeUndefined();
  });

  it('the refresh token never ends up in the state, a result or a failure', async () => {
    const { session } = await signedInMobile({ 'POST /auth/logout': offline });
    const result = await session.signOut();
    expect(JSON.stringify([result, session.getState()])).not.toContain('refresh-a');
    expect(JSON.stringify([result, session.getState()])).not.toContain('access-a');
  });
});

describe('refresh: single flight and no loops (the gaps)', () => {
  it('web: concurrent 401s share one refresh, and every request is repeated with the new CSRF token', async () => {
    let refreshed = false;
    const { api, session } = await signedInWeb({
      'POST /auth/change-password': (call) =>
        call.headers['x-csrf-token'] === 'csrf-2' && refreshed ? ok({})() : UNAUTHENTICATED(),
      'GET /auth/sessions': () => (refreshed ? SESSIONS() : UNAUTHENTICATED()),
      'POST /auth/refresh': async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        refreshed = true;
        return ok(webGrant('csrf-2'))();
      },
    });

    const results = await Promise.all([
      session.client.auth.sessions(),
      session.client.auth.changePassword({ currentPassword: PASSWORD, newPassword: PASSWORD }),
      session.client.auth.sessions(),
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    expect(api.count('POST /auth/refresh')).toBe(1);
    expect(api.count('GET /auth/sessions')).toBe(4);
    expect(api.count('POST /auth/change-password')).toBe(2);
  });

  /** Signed in on mobile; three requests at once all get 401 and the renewal is refused. */
  async function concurrentLoss() {
    const signedIn = await signedInMobile({
      'GET /auth/sessions': UNAUTHENTICATED,
      'GET /auth/me': UNAUTHENTICATED,
      'POST /auth/refresh': async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return UNAUTHENTICATED();
      },
    });
    const results = await Promise.all([
      signedIn.session.client.auth.sessions(),
      signedIn.session.client.auth.me(),
      signedIn.session.client.auth.sessions(),
    ]);
    return { ...signedIn, results };
  }

  it('concurrent 401s with a refused refresh: one refresh, signed out, no retries', async () => {
    const { api, session, results, current } = await concurrentLoss();
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(api.count('POST /auth/refresh')).toBe(1);
    // Each request went out once: none was repeated after the failed renewal.
    expect(api.count('GET /auth/sessions')).toBe(2);
    expect(api.count('GET /auth/me')).toBe(1);
    expect(session.getState().status).toBe('signedOut');
    await vi.waitFor(() => expect(current()).toBeNull());
  });

  // BUG: every request that loses its session calls `onAuthLost`
  // (packages/shared/src/api-client/auth-session.ts, `onAuthLost`). The first call signs out
  // with the notice 'session_expired' and forgets the tokens; the next call then finds neither a
  // signed-in state nor tokens, computes `hadSession = false` and overwrites the state with
  // `notice: null`. So when several requests are in flight (a page loading a few lists), the
  // user is not told that their session expired. Remove `.fails` once the notice is kept.
  it('concurrent 401s with a refused refresh still tell the user the session expired', async () => {
    const { session } = await concurrentLoss();
    expect(session.getState()).toEqual({ status: 'signedOut', notice: 'session_expired' });
  });

  it('single flight is per wave: a 401 after a finished renewal starts a new one', async () => {
    const { api, session } = await signedInMobile({
      'GET /auth/sessions': [UNAUTHENTICATED, SESSIONS, UNAUTHENTICATED, SESSIONS],
      'POST /auth/refresh': [ok(mobileGrant('b')), ok(mobileGrant('c'))],
    });
    expect((await session.client.auth.sessions()).ok).toBe(true);
    expect((await session.client.auth.sessions()).ok).toBe(true);
    expect(api.count('POST /auth/refresh')).toBe(2);
    expect(
      api.calls.filter((call) => call.route === 'POST /auth/refresh').map((call) => call.body),
    ).toEqual([{ refreshToken: 'refresh-a' }, { refreshToken: 'refresh-b' }]);
  });

  it('never renews through the refresh call itself, nor for sign-in or set-password', async () => {
    const api = fakeApi({
      'POST /auth/refresh': UNAUTHENTICATED,
      'POST /auth/login': UNAUTHENTICATED,
      'POST /auth/set-password': UNAUTHENTICATED,
    });
    const session = webSession(api);
    await session.client.auth.refresh();
    await session.signIn('sam', PASSWORD);
    await session.setPassword(CODE, PASSWORD);
    expect(api.count('POST /auth/refresh')).toBe(1);
    expect(api.count('POST /auth/login')).toBe(1);
    expect(api.count('POST /auth/set-password')).toBe(1);
  });

  it('a request that keeps answering 401 after renewals is tried at most twice per call', async () => {
    const { api, session } = await signedInMobile({
      'GET /auth/sessions': UNAUTHENTICATED,
      'POST /auth/refresh': ok(mobileGrant('b')),
    });
    await session.client.auth.sessions();
    await session.client.auth.sessions();
    // First call: request, refresh, repeat (still 401: signed out). Second call: signed out, so
    // no token and no renewal attempt.
    expect(api.count('GET /auth/sessions')).toBe(3);
    expect(api.count('POST /auth/refresh')).toBe(1);
  });
});

describe('failure mapping', () => {
  const http = (status: number, code: string): ApiFailure => ({
    kind: 'http',
    status,
    message: 'x',
    error: {
      statusCode: status,
      code: code as never,
      message: 'x',
      correlationId: null,
      timestamp: NOW,
    },
  });

  it('treats a timeout like no connection', () => {
    expect(signInFailureReason({ kind: 'timeout', message: 'No response' })).toBe('network');
  });

  it('recognises a rate limit by its code as well as by its status', () => {
    expect(signInFailureReason(http(403, 'rate_limited'))).toBe('rate_limited');
    expect(signInFailureReason(http(403, 'forbidden'))).toBe('unexpected');
    expect(setPasswordFailure(http(429, 'conflict')).reason).toBe('rate_limited');
  });

  it('does not call a server error an invalid code', () => {
    expect(setPasswordFailure(http(503, 'service_unavailable')).reason).toBe('unexpected');
  });
});
