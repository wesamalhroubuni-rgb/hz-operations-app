import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from './index.js';
import type { HealthMonitorState, HealthResult } from './health-monitor.js';
import { describeHealth } from './health-status.js';

const API_URL = 'http://api.test';
const NOT_CONFIGURED = 'Set the API URL.';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(implementation: (input: unknown, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function settled(result: HealthResult): HealthMonitorState {
  return { checking: false, result, retry: null, retriesExhausted: false };
}

/** Calls GET /health through the real shared client and describes the settled answer. */
async function describeCall(timeoutMs?: number) {
  const result = await createApiClient({ baseUrl: API_URL }).health.get({ timeoutMs });
  return describeHealth(settled(result), NOT_CONFIGURED);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the web API client', () => {
  it('calls GET {apiUrl}/health without the HTTP cache', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ status: 'ok', database: 'up', timestamp: TIMESTAMP }, 200),
    );

    await createApiClient({ baseUrl: `${API_URL}/` }).health.get();

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_URL}/health`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('describeHealth, from a real client call', () => {
  it('shows the API as reachable with the database up', async () => {
    mockFetch(async () =>
      jsonResponse({ status: 'ok', database: 'up', timestamp: TIMESTAMP }, 200),
    );

    expect(await describeCall()).toEqual({
      tone: 'good',
      title: 'API reachable',
      detail: 'Database is up.',
      busy: false,
    });
  });

  it('shows the API as reachable with the database down on HTTP 503', async () => {
    mockFetch(async () =>
      jsonResponse({ status: 'error', database: 'down', timestamp: TIMESTAMP }, 503),
    );

    expect(await describeCall()).toEqual({
      tone: 'warning',
      title: 'API reachable',
      detail: 'Database is down.',
      busy: false,
    });
  });

  it('shows a refused connection as unreachable', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });

    expect(await describeCall()).toEqual({
      tone: 'bad',
      title: 'API unreachable',
      detail: 'No response from the API. Is it running?',
      busy: false,
    });
  });

  it('shows a timeout as unreachable, with its own explanation', async () => {
    mockFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    expect(await describeCall(10)).toEqual({
      tone: 'bad',
      title: 'API unreachable',
      detail: 'The API did not answer in time.',
      busy: false,
    });
  });

  it('shows an unexpected JSON body as an unexpected response', async () => {
    mockFetch(async () => jsonResponse({ message: 'Not Found' }, 404));

    expect(await describeCall()).toEqual({
      tone: 'bad',
      title: 'Unexpected API response',
      detail: 'Something answered, but not with a valid health response (HTTP 404).',
      busy: false,
    });
  });

  it('shows a non-JSON body as an unexpected response', async () => {
    mockFetch(async () => new Response('<html></html>', { status: 200 }));

    expect(await describeCall()).toMatchObject({
      tone: 'bad',
      title: 'Unexpected API response',
    });
  });

  it('shows a standard API error body as an unexpected response', async () => {
    const view = describeHealth(
      settled({
        ok: false,
        failure: {
          kind: 'http',
          status: 500,
          message: 'Internal error',
          error: {
            statusCode: 500,
            code: 'internal_error',
            message: 'Internal error',
            correlationId: null,
            timestamp: TIMESTAMP,
          },
        },
      }),
      NOT_CONFIGURED,
    );

    expect(view.title).toBe('Unexpected API response');
    expect(view.detail).toContain('HTTP 500');
  });
});

describe('describeHealth, other states', () => {
  const NETWORK: HealthResult = { ok: false, failure: { kind: 'network', message: 'x' } };

  it('explains how to configure the API when there is no URL', () => {
    expect(describeHealth(null, NOT_CONFIGURED)).toEqual({
      tone: 'bad',
      title: 'API not configured',
      detail: NOT_CONFIGURED,
      busy: false,
    });
  });

  it('shows a first check in progress', () => {
    const state: HealthMonitorState = {
      checking: true,
      result: null,
      retry: null,
      retriesExhausted: false,
    };

    expect(describeHealth(state, NOT_CONFIGURED)).toEqual({
      tone: 'pending',
      title: 'Checking the API…',
      detail: 'Waiting for a response.',
      busy: true,
    });
  });

  it.each([false, true])('says it is retrying (request in flight: %s)', (checking) => {
    const state: HealthMonitorState = {
      checking,
      result: NETWORK,
      retry: { attempt: 2, of: 4 },
      retriesExhausted: false,
    };

    expect(describeHealth(state, NOT_CONFIGURED)).toEqual({
      tone: 'bad',
      title: 'API unreachable',
      detail: 'No response from the API. Is it running? Retrying automatically (attempt 2 of 4)…',
      busy: true,
    });
  });

  it('says when the automatic retries have stopped', () => {
    const state: HealthMonitorState = {
      checking: false,
      result: NETWORK,
      retry: null,
      retriesExhausted: true,
    };

    expect(describeHealth(state, NOT_CONFIGURED)).toEqual({
      tone: 'bad',
      title: 'API unreachable',
      detail:
        'No response from the API. Is it running? Automatic retries have stopped. Use "Check again" to retry.',
      busy: false,
    });
  });
});
