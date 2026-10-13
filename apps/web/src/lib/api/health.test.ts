import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchApiHealth } from './health';

const API_URL = 'http://api.test';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(implementation: () => Promise<Response>) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchApiHealth', () => {
  it('returns the health body when the API answers 200', async () => {
    const body = { status: 'ok', database: 'up', timestamp: '2026-01-01T00:00:00.000Z' };
    const fetchMock = mockFetch(async () => jsonResponse(body, 200));

    const result = await fetchApiHealth(API_URL);

    expect(result).toEqual({ reachable: true, health: body });
    expect(fetchMock).toHaveBeenCalledWith(`${API_URL}/health`, expect.any(Object));
  });

  it('ignores a trailing slash on the API URL', async () => {
    const body = { status: 'ok', database: 'up', timestamp: '2026-01-01T00:00:00.000Z' };
    const fetchMock = mockFetch(async () => jsonResponse(body, 200));

    await fetchApiHealth(`${API_URL}/`);

    expect(fetchMock).toHaveBeenCalledWith(`${API_URL}/health`, expect.any(Object));
  });

  it('still parses the body when the API answers 503 (database down)', async () => {
    const body = { status: 'error', database: 'down', timestamp: '2026-01-01T00:00:00.000Z' };
    mockFetch(async () => jsonResponse(body, 503));

    const result = await fetchApiHealth(API_URL);

    expect(result).toEqual({ reachable: true, health: body });
  });

  it('reports a network error as unreachable', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await fetchApiHealth(API_URL);

    expect(result).toEqual({ reachable: false, reason: 'network' });
  });

  it('reports an unexpected JSON body as an invalid response', async () => {
    mockFetch(async () => jsonResponse({ message: 'Not Found' }, 404));

    const result = await fetchApiHealth(API_URL);

    expect(result).toEqual({ reachable: false, reason: 'invalid-response' });
  });

  it('reports a non-JSON body as an invalid response', async () => {
    mockFetch(async () => new Response('<html></html>', { status: 200 }));

    const result = await fetchApiHealth(API_URL);

    expect(result).toEqual({ reachable: false, reason: 'invalid-response' });
  });
});
