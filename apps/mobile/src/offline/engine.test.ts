import {
  CLIENT_SYNC_HEADER,
  DEVICE_TIME_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  type ApiErrorCode,
} from '@ops/shared';

import { statusOf } from './engine';
import {
  createHarness,
  FakeQueue,
  flush,
  httpFailure,
  NETWORK_DOWN,
  photoFixture,
  pullFixture,
  taskFixture,
  testUuid,
  TIMED_OUT,
  workLogFixture,
  type Harness,
} from './engineTestKit';
import type { QueuedMutation } from './types';

const NOW = new Date('2026-10-27T10:00:00.000Z');

function createLog(clientId = testUuid(), extra: Record<string, unknown> = {}): QueuedMutation {
  return {
    kind: 'createWorkLog',
    body: {
      clientId,
      text: 'Fixed the pump',
      occurredAt: '2026-10-25T07:30:00.000Z',
      deviceCreatedAt: '2026-10-25T07:31:00.000Z',
      ...extra,
    } as never,
  };
}

function updateLog(clientId: string, expectedVersion = 1): QueuedMutation {
  return {
    kind: 'updateWorkLog',
    workLogClientId: clientId,
    body: { text: 'Fixed the pump and the valve', expectedVersion },
  };
}

function uploadPhoto(clientId: string, localId = 'photo-1'): QueuedMutation {
  return {
    kind: 'uploadAttachment',
    workLogClientId: clientId,
    workLogId: null,
    attachmentClientId: testUuid(),
    photo: photoFixture(localId),
    checkpoint: { attachmentId: null, stored: false },
  };
}

async function enqueue(h: Harness, mutation: QueuedMutation) {
  return (await h.queue.enqueue(mutation, NOW)).item;
}

describe('sync engine: pushing the queue', () => {
  it('sends a log, then its photo, with the stored ids and the offline headers', async () => {
    const h = createHarness();
    const clientId = testUuid();
    const create = await enqueue(h, createLog(clientId));
    const photo = await enqueue(h, uploadPhoto(clientId));
    h.photos.files.add('photo-1');

    const result = await h.engine.syncNow('manual');

    expect(result).toEqual({
      sent: 2,
      failedRetryable: 0,
      failedPermanent: 0,
      pulled: true,
      stoppedBecause: null,
    });
    expect(h.api.calls.map((call) => call.endpoint)).toEqual([
      'workLogs.create',
      'attachments.startUpload',
      'attachments.complete',
      'sync.pull',
    ]);
    const [createCall, startCall] = h.api.calls;
    expect(createCall?.headers).toEqual({
      [CLIENT_SYNC_HEADER]: 'offline',
      [DEVICE_TIME_HEADER]: NOW.toISOString(),
      [IDEMPOTENCY_KEY_HEADER]: create.idempotencyKey,
    });
    expect((createCall?.body as { clientId: string }).clientId).toBe(clientId);
    const log = h.api.logsByClientId.get(clientId);
    expect(startCall?.id).toBe(log?.id);
    expect(startCall?.headers[IDEMPOTENCY_KEY_HEADER]).toBe(photo.idempotencyKey);
    expect(h.puts).toEqual(['photo-1']);
    expect(h.photos.deleted).toEqual(['photo-1']);
    expect(h.queue.items).toEqual([]);
    expect(h.engine.getStatus()).toEqual({
      kind: 'synced',
      lastRefreshedAt: NOW.toISOString(),
    });
  });

  it('keeps the worker’s times and sends the phone clock at sending (clock skew)', async () => {
    const h = createHarness();
    const clientId = testUuid();
    await enqueue(h, createLog(clientId));
    // The phone clock runs three hours fast when the queue is finally sent.
    h.clock.advance(3 * 60 * 60 * 1000);

    await h.engine.syncNow('manual');

    const call = h.api.callsTo('workLogs.create')[0];
    expect(call?.headers[DEVICE_TIME_HEADER]).toBe('2026-10-27T13:00:00.000Z');
    expect(call?.body).toMatchObject({
      occurredAt: '2026-10-25T07:30:00.000Z',
      deviceCreatedAt: '2026-10-25T07:31:00.000Z',
    });
  });

  it('sends a record strictly in order and rebases the version of the next edit', async () => {
    const h = createHarness();
    const clientId = testUuid();
    await enqueue(h, createLog(clientId));
    await enqueue(h, updateLog(clientId, 1));
    await enqueue(h, {
      kind: 'changeWorkLogStatus',
      workLogClientId: clientId,
      body: { status: 'submitted', expectedVersion: 1 },
    });

    const result = await h.engine.syncNow('manual');

    expect(result.sent).toBe(3);
    expect(h.api.calls.map((call) => call.endpoint)).toEqual([
      'workLogs.create',
      'workLogs.update',
      'workLogs.changeStatus',
      'sync.pull',
    ]);
    // The status change was rebased on the edit's answer: no conflict with itself.
    expect(h.api.callsTo('workLogs.changeStatus')[0]?.body).toMatchObject({ expectedVersion: 2 });
  });

  it('holds back a record after its earlier item failed, but not other records', async () => {
    const h = createHarness();
    const a = testUuid();
    await enqueue(h, createLog(a));
    await enqueue(h, updateLog(a));
    const b = testUuid();
    await enqueue(h, createLog(b));
    h.api.interceptor = (call) =>
      call.endpoint === 'workLogs.create' && (call.body as { clientId: string }).clientId === a
        ? httpFailure('internal_error')
        : undefined;

    const result = await h.engine.syncNow('manual');

    expect(result).toMatchObject({ sent: 1, failedRetryable: 1, stoppedBecause: null });
    expect(h.api.callsTo('workLogs.update')).toHaveLength(0);
    expect(h.api.logsByClientId.has(b)).toBe(true);
    const states = h.queue.items.map((item) => [item.mutation.kind, item.state]);
    expect(states).toEqual([
      ['createWorkLog', 'failed_retryable'],
      ['updateWorkLog', 'pending'],
    ]);
  });

  it.each<[ApiErrorCode, QueuedMutation['kind']]>([
    ['version_conflict', 'updateWorkLog'],
    ['already_reviewed', 'updateWorkLog'],
    ['edit_window_closed', 'updateWorkLog'],
    ['record_archived', 'updateWorkLog'],
    ['occurred_at_out_of_range', 'createWorkLog'],
    ['task_cancelled', 'changeTaskStatus'],
    ['task_not_assigned', 'changeTaskStatus'],
    ['not_found', 'changeTaskStatus'],
    ['attachment_not_declared', 'uploadAttachment'],
    ['validation_failed', 'createWorkLog'],
    ['idempotency_key_reused', 'updateWorkLog'],
  ])('keeps a %s refusal of %s as a permanent failure', async (code, kind) => {
    const h = createHarness();
    const log = workLogFixture();
    await h.store.upsert('workLogs', [log]);
    h.api.logsById.set(log.id, log);
    const task = taskFixture();
    h.api.tasks.set(task.id, task);
    h.photos.files.add('photo-1');
    const mutation: QueuedMutation =
      kind === 'createWorkLog'
        ? createLog()
        : kind === 'updateWorkLog'
          ? updateLog(log.clientId)
          : kind === 'changeTaskStatus'
            ? { kind, taskId: task.id, body: { status: 'done', expectedVersion: 1 } }
            : uploadPhoto(log.clientId);
    const item = await enqueue(h, mutation);
    h.api.interceptor = (call) => (call.endpoint === 'sync.pull' ? undefined : httpFailure(code));

    const result = await h.engine.syncNow('manual');

    expect(result).toMatchObject({ failedPermanent: 1, failedRetryable: 0, pulled: true });
    const stored = await h.queue.get(item.id);
    expect(stored?.state).toBe('failed_permanent');
    expect(stored?.lastError).toMatchObject({ code });
    expect(stored?.nextAttemptAt).toBeNull();
    expect(h.engine.getStatus()).toEqual({ kind: 'failed', failed: 1, pending: 0 });
  });

  it('never sends a photo whose file is gone; it is kept as a permanent failure', async () => {
    const h = createHarness();
    const log = workLogFixture();
    await h.store.upsert('workLogs', [log]);
    const item = await enqueue(h, uploadPhoto(log.clientId, 'gone'));

    await h.engine.syncNow('manual');

    expect(h.api.callsTo('attachments.startUpload')).toHaveLength(0);
    expect((await h.queue.get(item.id))?.lastError?.code).toBe('photo_missing');
  });

  it('resumes a photo upload from its checkpoint (only complete was left)', async () => {
    const h = createHarness();
    const log = workLogFixture();
    await h.store.upsert('workLogs', [log]);
    h.photos.files.add('photo-1');
    const mutation = uploadPhoto(log.clientId);
    if (mutation.kind === 'uploadAttachment') {
      mutation.checkpoint = { attachmentId: 'attachment-1', stored: true };
    }
    await enqueue(h, mutation);

    await h.engine.syncNow('manual');

    expect(h.api.calls.map((call) => call.endpoint)).toEqual(['attachments.complete', 'sync.pull']);
    expect(h.puts).toEqual([]);
  });

  it('saves the upload checkpoint when the PUT fails, and retries from it', async () => {
    const h = createHarness();
    const log = workLogFixture();
    await h.store.upsert('workLogs', [log]);
    h.photos.files.add('photo-1');
    const item = await enqueue(h, uploadPhoto(log.clientId));
    h.putResult = { ok: false, status: 503, message: 'Storage answered 503' };
    const withLog = pullFixture({ workLogs: { upserts: [log], ids: [log.id] } });
    h.api.pullResponses.push(withLog, withLog);

    await h.engine.syncNow('manual');

    const stored = await h.queue.get(item.id);
    expect(stored?.state).toBe('failed_retryable');
    expect(stored?.mutation).toMatchObject({ checkpoint: { stored: false } });
    const attachmentId =
      stored?.mutation.kind === 'uploadAttachment' ? stored.mutation.checkpoint.attachmentId : null;
    expect(attachmentId).not.toBeNull();

    h.putResult = { ok: true };
    await h.engine.syncNow('manual');
    expect(h.api.callsTo('attachments.startUpload')).toHaveLength(1);
    expect(h.api.callsTo('attachments.renewUpload')).toHaveLength(1);
    expect(h.queue.items).toEqual([]);
  });
});

describe('sync engine: bad networks and crashes', () => {
  it('stops at a network loss mid-run, keeps everything, and skips the pull', async () => {
    const h = createHarness();
    const first = testUuid();
    const second = testUuid();
    const third = testUuid();
    await enqueue(h, createLog(first));
    await enqueue(h, createLog(second));
    await enqueue(h, createLog(third));
    h.api.interceptor = (call) =>
      (call.body as { clientId?: string } | null)?.clientId === second ? NETWORK_DOWN : undefined;

    const result = await h.engine.syncNow('manual');

    expect(result).toEqual({
      sent: 1,
      failedRetryable: 1,
      failedPermanent: 0,
      pulled: false,
      stoppedBecause: 'offline',
    });
    expect(h.api.callsTo('workLogs.create')).toHaveLength(2);
    expect(h.api.callsTo('sync.pull')).toHaveLength(0);
    const kept = await h.queue.list();
    expect(kept.map((item) => item.state)).toEqual(['failed_retryable', 'pending']);
    expect(kept[0]?.lastError?.code).toBe('network');
    expect(kept[0]?.nextAttemptAt).toBe(new Date(NOW.getTime() + 2000).toISOString());
  });

  it('treats a timeout as retryable and resends the same idempotent request', async () => {
    const h = createHarness();
    const clientId = testUuid();
    const item = await enqueue(h, updateLog(clientId));
    const log = workLogFixture({ clientId });
    await h.store.upsert('workLogs', [log]);
    h.api.logsById.set(log.id, log);
    let timeouts = 1;
    h.api.interceptor = (call) =>
      call.endpoint === 'workLogs.update' && timeouts-- > 0 ? TIMED_OUT : undefined;

    const first = await h.engine.syncNow('manual');
    expect(first.stoppedBecause).toBe('offline');
    expect((await h.queue.get(item.id))?.lastError?.code).toBe('timeout');

    const second = await h.engine.syncNow('manual');
    expect(second.sent).toBe(1);
    const keys = h.api
      .callsTo('workLogs.update')
      .map((call) => call.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys).toEqual([item.idempotencyKey, item.idempotencyKey]);
  });

  it('does not start a run while offline and syncs when the connection returns', async () => {
    const h = createHarness();
    await enqueue(h, createLog());
    h.network.set(false);
    h.engine.start();
    await flush(30);

    expect(h.api.calls).toHaveLength(0);
    expect(h.engine.getStatus()).toEqual({ kind: 'offline', pending: 1, failed: 0 });

    h.network.set(true);
    await flush(60);

    expect(h.api.callsTo('workLogs.create')).toHaveLength(1);
    expect(h.engine.getStatus().kind).toBe('synced');
    await h.engine.stop();
  });

  it('after a crash mid-send, resends the item once and the server does not duplicate it', async () => {
    const queue = new FakeQueue();
    const clientId = testUuid();
    // The app died after the server stored the log but before the answer arrived.
    const before = createHarness({ queue });
    const item = queue.seed({ mutation: createLog(clientId), state: 'sending' });
    await before.api.client.workLogs.create(
      { clientId },
      { headers: { [IDEMPOTENCY_KEY_HEADER]: item.idempotencyKey } },
    );

    const after = createHarness({ queue });
    after.api.logsByClientId = before.api.logsByClientId;
    after.api.logsById = before.api.logsById;
    after.engine.start();
    await flush(60);

    expect(after.api.callsTo('workLogs.create')).toHaveLength(1);
    expect(after.api.logsByClientId.size).toBe(1);
    expect(queue.items).toEqual([]);
    await after.engine.stop();
  });

  it('applies the backoff: no resend before nextAttemptAt, a resend after it', async () => {
    const h = createHarness();
    const item = await enqueue(h, createLog());
    let failures = 2;
    h.api.interceptor = (call) =>
      call.endpoint === 'workLogs.create' && failures-- > 0
        ? httpFailure('rate_limited')
        : undefined;

    await h.engine.syncNow('timer');
    expect((await h.queue.get(item.id))?.nextAttemptAt).toBe('2026-10-27T10:00:02.000Z');

    h.clock.advance(1000);
    await h.engine.syncNow('timer');
    expect(h.api.callsTo('workLogs.create')).toHaveLength(1);

    h.clock.advance(1000);
    await h.engine.syncNow('timer');
    expect(h.api.callsTo('workLogs.create')).toHaveLength(2);
    // Second failure: the wait doubled.
    expect((await h.queue.get(item.id))?.nextAttemptAt).toBe('2026-10-27T10:00:06.000Z');

    h.clock.advance(4000);
    await h.engine.syncNow('timer');
    expect(h.queue.items).toEqual([]);
  });

  it('lets "Sync now" skip the wait of a retryable item', async () => {
    const h = createHarness();
    await enqueue(h, createLog());
    let failures = 1;
    h.api.interceptor = (call) =>
      call.endpoint === 'workLogs.create' && failures-- > 0
        ? httpFailure('service_unavailable')
        : undefined;

    await h.engine.syncNow('timer');
    await h.engine.syncNow('manual');

    expect(h.api.callsTo('workLogs.create')).toHaveLength(2);
    expect(h.queue.items).toEqual([]);
  });

  it('schedules a wake-up for the next automatic retry', async () => {
    const h = createHarness();
    await enqueue(h, createLog());
    let failures = 1;
    h.api.interceptor = (call) =>
      call.endpoint === 'workLogs.create' && failures-- > 0 ? NETWORK_DOWN : undefined;

    await h.engine.syncNow('manual');
    await flush(20);
    expect([...h.scheduler.timers.values()].map((timer) => timer.ms)).toContain(2000);

    h.clock.advance(2000);
    h.scheduler.fire(2000);
    await flush(60);
    expect(h.queue.items).toEqual([]);
  });
});

describe('sync engine: one run at a time', () => {
  it('never runs two syncs at once; a trigger during a run gets one follow-up', async () => {
    const h = createHarness();
    await enqueue(h, createLog());
    await enqueue(h, createLog());
    let open: () => void = () => undefined;
    h.api.gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const first = h.engine.syncNow('manual');
    await flush();
    const second = h.engine.syncNow('foreground');
    const third = h.engine.syncNow('reconnect');
    expect(second).toBe(third);
    expect(h.engine.isRunning()).toBe(true);

    open();
    h.api.gate = null;
    const results = await Promise.all([first, second, third]);

    expect(h.api.maxInFlight).toBe(1);
    expect(results[0].sent).toBe(2);
    expect(results[1].sent).toBe(0);
    expect(h.api.callsTo('workLogs.create')).toHaveLength(2);
    expect(h.api.callsTo('sync.pull')).toHaveLength(2);
  });

  it('a double tap on "Sync now" sends each item once', async () => {
    const h = createHarness();
    const clientId = testUuid();
    await enqueue(h, createLog(clientId));

    await Promise.all([h.engine.syncNow('manual'), h.engine.syncNow('manual')]);

    expect(h.api.callsTo('workLogs.create')).toHaveLength(1);
    expect(h.api.logsByClientId.size).toBe(1);
  });

  it('a write queued while a run pulls gets its own follow-up run', async () => {
    const h = createHarness();
    let queued = false;
    h.api.interceptor = async (call) => {
      if (call.endpoint === 'sync.pull' && !queued) {
        queued = true;
        await enqueue(h, createLog());
      }
      return undefined;
    };

    await h.engine.syncNow('manual');
    await flush(80);

    expect(h.api.callsTo('workLogs.create')).toHaveLength(1);
    expect(h.queue.items).toEqual([]);
  });

  it('debounces an enqueue into one run', async () => {
    const h = createHarness({ enqueueDebounceMs: 1000 });
    h.engine.start();
    await flush(40);
    const pullsAtStart = h.api.callsTo('sync.pull').length;

    await enqueue(h, createLog());
    await enqueue(h, createLog());
    await flush(20);
    expect(h.scheduler.fire(1000)).toBeGreaterThanOrEqual(1);
    await flush(80);

    expect(h.api.callsTo('workLogs.create')).toHaveLength(2);
    expect(h.api.callsTo('sync.pull')).toHaveLength(pullsAtStart + 1);
    await h.engine.stop();
  });
});

describe('sync engine: sessions', () => {
  it('stops at a 401 the refresh could not fix, keeps the queue, and resumes after sign-in', async () => {
    const h = createHarness();
    const statuses: string[] = [];
    h.engine.subscribe((status) => statuses.push(status.kind));
    const first = await enqueue(h, createLog());
    await enqueue(h, createLog());
    h.api.interceptor = () => httpFailure('unauthenticated');

    const result = await h.engine.syncNow('manual');

    expect(result.stoppedBecause).toBe('needsSignIn');
    expect(h.needsSignIn).toHaveBeenCalledTimes(1);
    expect(h.api.calls).toHaveLength(1);
    expect((await h.queue.get(first.id))?.state).toBe('failed_retryable');
    expect(h.engine.getStatus()).toEqual({ kind: 'needsSignIn', pending: 2, failed: 0 });

    // Automatic triggers wait for the sign-in.
    expect((await h.engine.syncNow('reconnect')).stoppedBecause).toBe('needsSignIn');
    expect((await h.engine.syncNow('timer')).stoppedBecause).toBe('needsSignIn');
    expect(h.api.calls).toHaveLength(1);

    // The same user signs in again: the session's start resumes the queue.
    h.api.interceptor = null;
    const resumed = await h.engine.syncNow('start');
    expect(resumed.sent).toBe(2);
    expect(h.engine.getStatus().kind).toBe('synced');
    expect(statuses).toContain('needsSignIn');
  });

  it('reports needsSignIn when only the pull is refused', async () => {
    const h = createHarness();
    h.api.pullResponses.push(httpFailure('unauthenticated'));

    const result = await h.engine.syncNow('manual');

    expect(result).toMatchObject({ pulled: false, stoppedBecause: 'needsSignIn' });
    expect(h.needsSignIn).toHaveBeenCalledTimes(1);
  });

  it('stop() lets the request in flight finish and starts nothing new', async () => {
    const h = createHarness();
    await enqueue(h, createLog());
    await enqueue(h, createLog());
    let open: () => void = () => undefined;
    h.api.gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const run = h.engine.syncNow('manual');
    await flush();
    const stopping = h.engine.stop();
    open();
    await stopping;
    const result = await run;

    expect(result.stoppedBecause).toBe('stopped');
    expect(h.api.callsTo('workLogs.create')).toHaveLength(1);
    expect(h.queue.items).toHaveLength(1);
    expect((await h.engine.syncNow('manual')).stoppedBecause).toBe('stopped');
  });
});

describe('sync engine: pulling', () => {
  it('sends the stored cursor and applies the pull, pruning what left the scope', async () => {
    const h = createHarness();
    const kept = taskFixture();
    const reassigned = taskFixture();
    await h.store.upsert('tasks', [kept, reassigned]);
    await h.store.setSyncMeta({ cursor: 'cursor-0' });
    h.api.pullResponses.push(
      pullFixture({ full: false, cursor: 'cursor-1', tasks: { upserts: [], ids: [kept.id] } }),
    );

    const result = await h.engine.syncNow('manual');

    expect(result.pulled).toBe(true);
    expect(h.api.callsTo('sync.pull')[0]?.body).toEqual({ cursor: 'cursor-0' });
    expect(await h.store.list('tasks')).toEqual([kept]);
    expect(h.store.meta.cursor).toBe('cursor-1');
    expect(h.store.meta.lastRefreshedAt).toBe(NOW.toISOString());
    expect(h.engine.getLastRefreshedAt()).toBe(NOW.toISOString());
  });

  it('pulls in full once when a delta names an id it did not send', async () => {
    const h = createHarness();
    await h.store.setSyncMeta({ cursor: 'cursor-0' });
    const unknown = taskFixture();
    h.api.pullResponses.push(
      pullFixture({ full: false, tasks: { upserts: [], ids: [unknown.id] } }),
      pullFixture({ full: true, tasks: { upserts: [unknown], ids: [unknown.id] } }),
    );

    await h.engine.syncNow('manual');

    expect(h.api.callsTo('sync.pull').map((call) => call.body)).toEqual([
      { cursor: 'cursor-0' },
      {},
    ]);
    expect(await h.store.list('tasks')).toEqual([unknown]);
  });

  it('a timer run that sent nothing does not pull again within a minute', async () => {
    const h = createHarness();
    await h.engine.syncNow('manual');
    h.clock.advance(30_000);
    await h.engine.syncNow('timer');
    expect(h.api.callsTo('sync.pull')).toHaveLength(1);
    h.clock.advance(30_000);
    await h.engine.syncNow('timer');
    expect(h.api.callsTo('sync.pull')).toHaveLength(2);
  });

  it('keeps the queue and the cache when the pull fails', async () => {
    const h = createHarness();
    const task = taskFixture();
    await h.store.upsert('tasks', [task]);
    h.api.pullResponses.push(httpFailure('internal_error'));

    const result = await h.engine.syncNow('manual');

    expect(result).toMatchObject({ pulled: false, stoppedBecause: null });
    expect(await h.store.list('tasks')).toEqual([task]);
  });
});

describe('statusOf', () => {
  const zero = { pending: 0, sending: 0, failed_retryable: 0, failed_permanent: 0, done: 0 };
  const base = { running: false, online: true, needsSignIn: false, lastRefreshedAt: null };

  it('orders: sign-in needed, offline, syncing, failed, pending, synced', () => {
    const counts = { ...zero, pending: 2, failed_retryable: 1, failed_permanent: 1 };
    expect(statusOf({ ...base, counts, needsSignIn: true, online: false })).toEqual({
      kind: 'needsSignIn',
      pending: 3,
      failed: 1,
    });
    expect(statusOf({ ...base, counts, online: false, running: true })).toEqual({
      kind: 'offline',
      pending: 3,
      failed: 1,
    });
    expect(statusOf({ ...base, counts, running: true })).toEqual({ kind: 'syncing', pending: 3 });
    expect(statusOf({ ...base, counts })).toEqual({ kind: 'failed', failed: 1, pending: 3 });
    expect(statusOf({ ...base, counts: { ...zero, sending: 1 } })).toEqual({
      kind: 'pending',
      pending: 1,
    });
    expect(statusOf({ ...base, counts: zero, lastRefreshedAt: 'x' })).toEqual({
      kind: 'synced',
      lastRefreshedAt: 'x',
    });
  });
});
