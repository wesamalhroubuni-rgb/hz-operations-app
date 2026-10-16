import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebApiClient, createWebAuthSession } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWebApiClient', () => {
  it('never serves API calls from the HTTP cache', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ status: 'ok', database: 'up', timestamp: '2026-01-01T00:00:00.000Z' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createWebApiClient('http://api.test/').health.get();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/health',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });

  it('sends the cookies with every call and never an Authorization header', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      Response.json({ status: 'ok', database: 'up', timestamp: '2026-01-01T00:00:00.000Z' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createWebApiClient('http://api.test').health.get();

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
    expect(init?.headers).not.toHaveProperty('Authorization');
  });
});

describe('createWebAuthSession', () => {
  it('signs in as a web client, so the API answers with cookies and not with tokens', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      Response.json({ message: 'not the contract' }, { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createWebAuthSession('http://api.test').signIn('someone', 'a password');

    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/auth/login');
    expect(JSON.parse(String(init?.body))).toMatchObject({ client: 'web' });
    expect(init?.credentials).toBe('include');
  });
});
