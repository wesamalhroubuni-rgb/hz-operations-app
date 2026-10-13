import { fetchHealth } from './health';

const API_URL = 'http://api.test';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status < 400, json: async () => body } as Response;
}

describe('fetchHealth', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the parsed health when the API and database are up', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { status: 'ok', database: 'up', timestamp: TIMESTAMP }),
    );

    const result = await fetchHealth(API_URL);

    expect(fetchMock).toHaveBeenCalledWith(`${API_URL}/health`, expect.any(Object));
    expect(result).toEqual({
      reachable: true,
      health: { status: 'ok', database: 'up', timestamp: TIMESTAMP },
    });
  });

  it('still parses the body of a 503 response when the database is down', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { status: 'error', database: 'down', timestamp: TIMESTAMP }),
    );

    const result = await fetchHealth(API_URL);

    expect(result).toEqual({
      reachable: true,
      health: { status: 'error', database: 'down', timestamp: TIMESTAMP },
    });
  });

  it('reports a network failure as unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));

    const result = await fetchHealth(API_URL);

    expect(result).toMatchObject({ reachable: false, reason: 'network' });
  });

  it('reports a body that does not match the schema as an invalid response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { hello: 'world' }));

    const result = await fetchHealth(API_URL);

    expect(result).toMatchObject({ reachable: false, reason: 'invalid-response' });
  });

  it('aborts and reports a timeout when the API does not answer in time', async () => {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const result = await fetchHealth(API_URL, { timeoutMs: 10 });

    expect(result).toMatchObject({ reachable: false, reason: 'timeout' });
  });
});
