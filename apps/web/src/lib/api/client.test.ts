import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebApiClient } from './client';

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
});
