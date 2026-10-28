import type { ApiFailure, ApiResult, Task, WorkLog } from '@ops/shared';

import {
  createBody,
  memoryLayer,
  ORG,
  photo,
  pull,
  T0,
  task,
  USER_A,
  workLog,
  at,
} from '../offline/storeTestKit';
import { createOfflineRepositories, PHOTO_STORAGE_FULL } from './repositories';
import { isRetryableWriteError, toWriteError } from './results';

const network: ApiFailure = { kind: 'network', message: 'Network request failed' };

function setup(options: { limitBytes?: number } = {}) {
  const layer = memoryLayer(USER_A, options);
  const client = {
    workLogs: {
      get: jest.fn(async (): Promise<ApiResult<WorkLog>> => ({ ok: false, failure: network })),
    },
    tasks: {
      get: jest.fn(async (): Promise<ApiResult<Task>> => ({ ok: false, failure: network })),
    },
    notifications: {
      markRead: jest.fn(async () => ({
        ok: true,
        status: 200,
        data: { id: 'n-1', readAt: T0.toISOString() },
      })),
      markAllRead: jest.fn(async () => ({ ok: true, status: 204, data: undefined })),
      registerPushToken: jest.fn(),
      unregisterPushToken: jest.fn(),
    },
  };
  let now = at(1);
  const repositories = createOfflineRepositories({
    user: { id: USER_A, organizationId: ORG },
    store: layer.store,
    queue: layer.queue,
    photos: layer.photos,
    client: client as never,
    newId: layer.newId,
    clock: () => now,
  });
  return { ...layer, client, repositories, setNow: (date: Date) => (now = date) };
}

describe('offline repositories: every write goes to the queue first', () => {
  it('create queues the log and its declared photos (moved to the photo store) and answers pending', async () => {
    const { repositories, queue, files } = setup();
    files.seed(photo('p1').uri, 1000);
    const result = await repositories.workLogs.create(createBody({ clientId: 'c1' }), [
      photo('p1'),
    ]);
    expect(result).toEqual({ ok: true, data: { clientId: 'c1', sync: 'pending', log: null } });
    const items = await queue.list();
    expect(items.map((item) => item.mutation.kind)).toEqual(['createWorkLog', 'uploadAttachment']);
    const declared = (
      items[0]!.mutation as { body: { attachmentClientIds: string[]; deviceCreatedAt: string } }
    ).body;
    const upload = items[1]!.mutation as { attachmentClientId: string; photo: { uri: string } };
    expect(declared.attachmentClientIds).toEqual([upload.attachmentClientId]);
    expect(declared.deviceCreatedAt).toBe(at(1).toISOString());
    expect(upload.photo.uri).toBe(`file:///documents/offline-photos/${USER_A}/p1.jpg`);
  });

  it('a double save queues one log; a log already synced answers settled', async () => {
    const { repositories, queue, store, files } = setup();
    files.seed(photo('p1').uri, 1000);
    await repositories.workLogs.create(createBody({ clientId: 'c1' }), [photo('p1')]);
    const again = await repositories.workLogs.create(createBody({ clientId: 'c1' }), [photo('p1')]);
    expect(again).toMatchObject({ ok: true, data: { sync: 'pending' } });
    expect(await queue.pendingCount()).toBe(2);

    await store.upsert('workLogs', [workLog({ id: 'l2', clientId: 'c2' })]);
    expect(await repositories.workLogs.create(createBody({ clientId: 'c2' }))).toMatchObject({
      ok: true,
      data: { sync: 'settled', log: { id: 'l2' } },
    });
  });

  it('refuses at once an occurredAt outside the backdating limit (nothing queued)', async () => {
    const { repositories, queue, store } = setup();
    await store.applyPull(pull(), T0); // organization: 7 days
    const old = new Date(T0.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    const result = await repositories.workLogs.create(createBody({ occurredAt: old }));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'invalid', details: [{ path: 'occurredAt' }] },
    });
    expect(await queue.pendingCount()).toBe(0);
  });

  it('refuses photos past the storage limit with a clear code, keeping the form', async () => {
    const { repositories, queue, files } = setup({ limitBytes: 1500 });
    files.seed(photo('p1').uri, 1000);
    files.seed(photo('p2').uri, 1000);
    const result = await repositories.workLogs.create(createBody(), [photo('p1'), photo('p2')]);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid',
        message: PHOTO_STORAGE_FULL,
        details: [{ path: 'photos', message: PHOTO_STORAGE_FULL }],
      },
    });
    expect(await queue.pendingCount()).toBe(0);
    expect(files.files.has(photo('p1').uri)).toBe(true);
    // The log without photos can still be saved.
    expect((await repositories.workLogs.create(createBody())).ok).toBe(true);
  });

  it('two saves at once cannot both pass the storage check: the second is refused whole', async () => {
    const { repositories, queue, files } = setup({ limitBytes: 1500 });
    files.seed(photo('p1').uri, 1000);
    files.seed(photo('p2').uri, 1000);
    const [first, second] = await Promise.all([
      repositories.workLogs.create(createBody({ clientId: 'c1' }), [photo('p1')]),
      repositories.workLogs.create(createBody({ clientId: 'c2' }), [photo('p2')]),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      error: { details: [{ path: 'photos', message: PHOTO_STORAGE_FULL }] },
    });
    expect((await queue.list()).map((item) => item.mutation.kind)).toEqual([
      'createWorkLog',
      'uploadAttachment',
    ]);
  });

  it('a photo refused after the check fails the whole save (never a partial one)', async () => {
    const { repositories, queue, files, photos } = setup();
    files.seed(photo('p1').uri, 1000);
    files.seed(photo('p2').uri, 1000);
    const save = photos.save.bind(photos);
    let calls = 0;
    photos.save = async (input) => {
      calls += 1;
      return calls === 2 ? { ok: false, reason: 'full' } : save(input);
    };
    const result = await repositories.workLogs.create(createBody(), [photo('p1'), photo('p2')]);
    expect(result).toMatchObject({
      ok: false,
      error: { details: [{ path: 'photos', message: PHOTO_STORAGE_FULL }] },
    });
    expect(await queue.pendingCount()).toBe(0);
  });

  it('an edit of a synced log is queued with the cached version and shown at once', async () => {
    const { repositories, queue, store } = setup();
    await store.upsert('workLogs', [workLog({ id: 'l1', clientId: 'c1', version: 4 })]);
    const result = await repositories.workLogs.update('l1', { text: 'changed' });
    expect(result).toMatchObject({ ok: true, data: { id: 'l1', text: 'changed' } });
    expect((await queue.list())[0]?.mutation).toEqual({
      kind: 'updateWorkLog',
      workLogClientId: 'c1',
      body: { text: 'changed', expectedVersion: 4 },
    });
  });

  it('an edit or submit of a log not sent yet works by clientId and merges into its create', async () => {
    const { repositories, queue } = setup();
    await repositories.workLogs.create(createBody({ clientId: 'c1', status: 'draft' }));
    await repositories.workLogs.update('c1', { text: 'better' });
    const submitted = await repositories.workLogs.changeStatus('c1', { status: 'submitted' });
    expect(submitted).toMatchObject({ ok: true, data: { id: 'c1', status: 'submitted' } });
    const items = await queue.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.mutation).toMatchObject({ body: { text: 'better', status: 'submitted' } });
  });

  it('a task status change is queued with the cached version', async () => {
    const { repositories, queue, store } = setup();
    await store.upsert('tasks', [task({ version: 3 })]);
    const result = await repositories.tasks.changeStatus('task-1', { status: 'in_progress' });
    expect(result).toMatchObject({ ok: true, data: { status: 'in_progress' } });
    expect((await queue.list())[0]?.mutation).toEqual({
      kind: 'changeTaskStatus',
      taskId: 'task-1',
      body: { status: 'in_progress', expectedVersion: 3 },
    });
  });

  it('a record the phone does not hold, offline: reported as a network problem, nothing queued', async () => {
    const { repositories, queue } = setup();
    expect(await repositories.tasks.changeStatus('unknown', { status: 'done' })).toMatchObject({
      ok: false,
      error: { kind: 'network' },
    });
    expect(await repositories.workLogs.update('unknown', { text: 'x' })).toMatchObject({
      ok: false,
      error: { kind: 'network' },
    });
    expect(await queue.pendingCount()).toBe(0);
  });

  it('photos added to a synced log are queued with its server id', async () => {
    const { repositories, queue, store, files } = setup();
    await store.upsert('workLogs', [workLog({ id: 'l1', clientId: 'c1' })]);
    files.seed(photo('p1').uri, 10);
    expect(await repositories.attachments.add('l1', [photo('p1')])).toEqual({
      ok: true,
      data: { queued: 1 },
    });
    expect((await queue.list())[0]?.mutation).toMatchObject({
      workLogClientId: 'c1',
      workLogId: 'l1',
    });
  });

  it('marking a notification read updates the phone copy on success', async () => {
    const { repositories, store } = setup();
    expect((await repositories.notifications.markRead('n-1')).ok).toBe(true);
    expect((await store.get('notifications', 'n-1'))?.readAt).toBe(T0.toISOString());
  });
});

describe('toWriteError', () => {
  it('maps failures to the kinds the screens know', () => {
    expect(toWriteError(network).kind).toBe('network');
    expect(toWriteError({ kind: 'timeout', message: 't' }).kind).toBe('network');
    expect(toWriteError({ kind: 'invalid-response', status: 200, message: 'x' }).kind).toBe(
      'server',
    );
  });

  it('offers "try again" only for failures that can pass', () => {
    expect(isRetryableWriteError({ kind: 'network', message: '', details: [] })).toBe(true);
    expect(isRetryableWriteError({ kind: 'conflict', message: '', details: [] })).toBe(false);
  });
});
