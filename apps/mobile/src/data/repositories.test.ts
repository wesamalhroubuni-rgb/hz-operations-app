import type { ApiClient, ApiFailure, ApiResult, Task, WorkLog } from '@ops/shared';

import { createRemoteRepositories, type CacheSync } from './repositories';
import { isRetryableWriteError, toWriteError } from './results';

const NOW = '2026-10-16T10:00:00.000Z';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function http(status: number, details: { path: string; message: string }[] = []): ApiFailure {
  return {
    kind: 'http',
    status,
    message: `HTTP ${status}`,
    error: {
      statusCode: status,
      code: 'validation_failed',
      message: `HTTP ${status}`,
      details,
      correlationId: null,
      timestamp: NOW,
    },
  };
}

const log = { id: 'log-1', clientId: CLIENT_ID, status: 'submitted' } as WorkLog;
const task = { id: 'task-1', status: 'in_progress' } as Task;

function fakeCache() {
  const events: string[] = [];
  const cache: CacheSync = {
    workLogChanged: (changed) => events.push(`log:${changed.id}`),
    taskChanged: (changed) => events.push(`task:${changed.id}`),
    attachmentsChanged: (id) => events.push(`attachments:${id}`),
    notificationsChanged: () => events.push('notifications'),
  };
  return { cache, events };
}

type Client = Parameters<typeof createRemoteRepositories>[0];

function fakeClient(
  overrides: { create?: jest.Mock; changeTaskStatus?: jest.Mock; markRead?: jest.Mock } = {},
): Client {
  return {
    workLogs: {
      create:
        overrides.create ??
        jest.fn(async (): Promise<ApiResult<WorkLog>> => ({ ok: true, status: 201, data: log })),
      update: jest.fn(async (): Promise<ApiResult<WorkLog>> => ({
        ok: true,
        status: 200,
        data: log,
      })),
      changeStatus: jest.fn(async (): Promise<ApiResult<WorkLog>> => ({
        ok: true,
        status: 200,
        data: log,
      })),
    },
    tasks: {
      changeStatus:
        overrides.changeTaskStatus ??
        jest.fn(async (): Promise<ApiResult<Task>> => ({ ok: true, status: 200, data: task })),
    },
    attachments: {},
    notifications: {
      markRead: overrides.markRead ?? jest.fn(async () => ({ ok: true, status: 200, data: {} })),
      markAllRead: jest.fn(async () => ({ ok: true, status: 204, data: undefined })),
      registerPushToken: jest.fn(async () => ({ ok: true, status: 204, data: undefined })),
      unregisterPushToken: jest.fn(async () => ({ ok: true, status: 204, data: undefined })),
    },
  } as unknown as Pick<ApiClient, 'workLogs' | 'tasks' | 'attachments' | 'notifications'>;
}

const putFile = () => async () => ({ ok: true as const });

describe('work logs repository', () => {
  const body = { clientId: CLIENT_ID, occurredAt: NOW };

  it('creates the log, answers it as settled, and refreshes the cache', async () => {
    const { cache, events } = fakeCache();
    const repositories = createRemoteRepositories(fakeClient(), cache, putFile);
    const result = await repositories.workLogs.create(body);
    expect(result).toEqual({ ok: true, data: { clientId: CLIENT_ID, sync: 'settled', log } });
    expect(events).toEqual(['log:log-1']);
  });

  it('repeats a create once with the same clientId when the answer was lost', async () => {
    const create = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, failure: { kind: 'timeout', message: 'slow' } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: log });
    const repositories = createRemoteRepositories(
      fakeClient({ create }),
      fakeCache().cache,
      putFile,
    );
    const result = await repositories.workLogs.create(body);
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toBe(create.mock.calls[1][0]);
  });

  it('does not repeat a refused create and returns the field details', async () => {
    const create = jest.fn().mockResolvedValue({
      ok: false,
      failure: http(400, [{ path: 'customFields.count', message: 'must be a number' }]),
    });
    const { cache, events } = fakeCache();
    const result = await createRemoteRepositories(
      fakeClient({ create }),
      cache,
      putFile,
    ).workLogs.create(body);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid',
        message: 'HTTP 400',
        details: [{ path: 'customFields.count', message: 'must be a number' }],
      },
    });
    expect(events).toEqual([]);
  });
});

/**
 * A fake API that behaves like the server on `clientId`: the first request stores the log (201),
 * a repeat returns the stored one (200). `lose` drops the answers of the next N requests AFTER the
 * server has handled them, as a dying mobile connection does.
 */
function idempotentServer() {
  const stored = new Map<string, WorkLog>();
  let lose = 0;
  let requests = 0;
  const create = jest.fn(
    async (body: { clientId: string; text?: string | null }): Promise<ApiResult<WorkLog>> => {
      requests += 1;
      const existing = stored.get(body.clientId);
      const log =
        existing ??
        ({
          id: `log-${stored.size + 1}`,
          clientId: body.clientId,
          text: body.text ?? null,
        } as WorkLog);
      stored.set(body.clientId, log);
      if (lose > 0) {
        lose -= 1;
        return { ok: false, failure: { kind: 'network', message: 'connection lost' } };
      }
      return { ok: true, status: existing ? 200 : 201, data: log };
    },
  );
  return {
    create,
    stored,
    loseNext: (count: number) => {
      lose = count;
    },
    requests: () => requests,
  };
}

describe('duplicate submit with the same clientId (Phase 4 coverage)', () => {
  const body = { clientId: CLIENT_ID, occurredAt: NOW, text: 'Replaced the filter' };

  it('a retry after a lost answer returns the same log, settled; the server holds one log', async () => {
    const server = idempotentServer();
    server.loseNext(1);
    const { cache, events } = fakeCache();
    const result = await createRemoteRepositories(
      fakeClient({ create: server.create }),
      cache,
      putFile,
    ).workLogs.create(body);
    expect(result).toEqual({
      ok: true,
      data: { clientId: CLIENT_ID, sync: 'settled', log: server.stored.get(CLIENT_ID) },
    });
    expect(server.requests()).toBe(2);
    expect(server.stored.size).toBe(1);
    expect(events).toEqual(['log:log-1']);
  });

  it('when both answers are lost it reports a retryable network error (no log), and a later save with the same body gets the same log', async () => {
    const server = idempotentServer();
    server.loseNext(2);
    const { cache, events } = fakeCache();
    const repositories = createRemoteRepositories(
      fakeClient({ create: server.create }),
      cache,
      putFile,
    );

    const failed = await repositories.workLogs.create(body);
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error.kind).toBe('network');
    expect(failed.ok === false && isRetryableWriteError(failed.error)).toBe(true);
    expect(events).toEqual([]);

    // The form keeps its clientId; the worker taps "save" again.
    const saved = await repositories.workLogs.create(body);
    expect(saved.ok && saved.data.log?.id).toBe('log-1');
    expect(server.stored.size).toBe(1);
    expect(server.requests()).toBe(3);
  });

  it('a double tap (two saves at once) gives both callers the same log', async () => {
    const server = idempotentServer();
    const repositories = createRemoteRepositories(
      fakeClient({ create: server.create }),
      fakeCache().cache,
      putFile,
    );
    const [one, two] = await Promise.all([
      repositories.workLogs.create(body),
      repositories.workLogs.create(body),
    ]);
    expect(one.ok && two.ok && one.data.log?.id === two.data.log?.id).toBe(true);
    expect(server.stored.size).toBe(1);
  });

  it('does not repeat on a server error (5xx) or a conflict (409: clientId of another user)', async () => {
    for (const status of [500, 409]) {
      const create = jest.fn().mockResolvedValue({ ok: false, failure: http(status) });
      const result = await createRemoteRepositories(
        fakeClient({ create }),
        fakeCache().cache,
        putFile,
      ).workLogs.create(body);
      expect(create).toHaveBeenCalledTimes(1);
      expect(result.ok === false && result.error.kind).toBe(status === 500 ? 'server' : 'conflict');
    }
  });

  it('answers a settled save with the clientId it was given and the server log', async () => {
    const created = { ...log, clientId: CLIENT_ID };
    const create = jest.fn(async () => ({ ok: true, status: 200, data: created }));
    const result = await createRemoteRepositories(
      fakeClient({ create }),
      fakeCache().cache,
      putFile,
    ).workLogs.create(body);
    expect(result.ok && result.data).toEqual({
      clientId: CLIENT_ID,
      sync: 'settled',
      log: created,
    });
  });
});

describe('tasks repository', () => {
  it('changes the status and refreshes the task', async () => {
    const changeTaskStatus = jest.fn(async () => ({ ok: true, status: 200, data: task }));
    const { cache, events } = fakeCache();
    const result = await createRemoteRepositories(
      fakeClient({ changeTaskStatus }),
      cache,
      putFile,
    ).tasks.changeStatus('task-1', { status: 'blocked', reason: 'No ladder' });
    expect(result.ok).toBe(true);
    expect(changeTaskStatus).toHaveBeenCalledWith('task-1', {
      status: 'blocked',
      reason: 'No ladder',
    });
    expect(events).toEqual(['task:task-1']);
  });

  it('reports a forbidden change as such', async () => {
    const changeTaskStatus = jest.fn(async () => ({ ok: false, failure: http(403) }));
    const result = await createRemoteRepositories(
      fakeClient({ changeTaskStatus }),
      fakeCache().cache,
      putFile,
    ).tasks.changeStatus('task-1', { status: 'cancelled' });
    expect(result.ok === false && result.error.kind).toBe('forbidden');
  });
});

describe('notifications repository', () => {
  it('refreshes the list after marking read', async () => {
    const { cache, events } = fakeCache();
    const repositories = createRemoteRepositories(fakeClient(), cache, putFile);
    await repositories.notifications.markRead('n-1');
    await repositories.notifications.markAllRead();
    expect(events).toEqual(['notifications', 'notifications']);
  });
});

describe('toWriteError', () => {
  it.each([
    [{ kind: 'network', message: 'x' } as ApiFailure, 'network'],
    [{ kind: 'timeout', message: 'x' } as ApiFailure, 'network'],
    [{ kind: 'invalid-response', status: 200, message: 'x' } as ApiFailure, 'server'],
    [http(400), 'invalid'],
    [http(422), 'invalid'],
    [http(401), 'signedOut'],
    [http(403), 'forbidden'],
    [http(404), 'notFound'],
    [http(409), 'conflict'],
    [http(429), 'network'],
    [http(500), 'server'],
  ])('%#', (failure, kind) => {
    expect(toWriteError(failure).kind).toBe(kind);
  });

  it('offers "try again" only for failures that can pass', () => {
    expect(isRetryableWriteError({ kind: 'network', message: '', details: [] })).toBe(true);
    expect(isRetryableWriteError({ kind: 'invalid', message: '', details: [] })).toBe(false);
  });
});
