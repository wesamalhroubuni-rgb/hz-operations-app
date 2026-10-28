import { IDEMPOTENCY_KEY_HEADER, type ApiFailure, type AuthUser } from '@ops/shared';

import { createOfflineRepositories, PHOTO_STORAGE_FULL } from '../data/repositories';
import { createMemoryStore } from '../storage/keyValueStore';
import { createMemoryDatabase, type OfflineDatabase } from './db';
import { createSyncEngine } from './engine';
import {
  ceilingRetry,
  FakeApi,
  FakeNetwork,
  httpFailure,
  ManualScheduler,
  pullFixture,
} from './engineTestKit';
import { createKeptUsersRegister, createOfflineIdentityStore } from './identity';
import { signOutWithChoice } from './lifecycle';
import { createMemoryPhotoFiles } from './photoStore';
import { createOfflineSessionFactory, type AppOfflineSession } from './session';
import {
  createBody,
  idSequence,
  ORG,
  photo,
  T0,
  task,
  USER_A,
  USER_B,
  workLog,
} from './storeTestKit';
import type { SignOutChoice } from './types';

// The whole offline layer of one phone wired together: the per-user session factory, the real
// write queue and local store over in-memory databases, the real photo store over in-memory
// files, the repositories the screens call, and the real sync engine against a fake server
// (one per user: the access token decides who the server sees). The unit suites test each part
// with fakes; this suite tests that the parts keep the Phase 5 promises together (ADR-0008):
// nothing lost across restarts, no duplicates, per-record ordering, conflicts kept with their
// reason, token expiry, a user switch on the same phone, and sign-out with queued writes.

jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only' }));

type MemoryDatabase = ReturnType<typeof createMemoryDatabase>;

const network: ApiFailure = { kind: 'network', message: 'Network request failed' };

/** A phone: storage that survives restarts, and a fresh app process on every `boot()`. */
function phone(options: { photoLimitBytes?: number } = {}) {
  const databases = new Map<string, MemoryDatabase>();
  const deleted: string[] = [];
  const files = createMemoryPhotoFiles();
  const kv = createMemoryStore();
  const secure = new Map<string, string>();
  const servers = new Map<string, FakeApi>();
  const net = new FakeNetwork();
  const needsSignIn: string[] = [];
  const puts: string[] = [];
  let now = T0;

  /** The server as the given user's session sees it; its pulls reflect its current records. */
  function server(userId: string): FakeApi {
    let api = servers.get(userId);
    if (!api) {
      const created = new FakeApi();
      const pull = created.client.sync.pull;
      (created.client.sync as { pull: typeof pull }).pull = (query) => {
        if (created.pullResponses.length === 0) {
          const logs = [...created.logsById.values()];
          const tasks = [...created.tasks.values()];
          created.pullResponses.push(
            pullFixture({
              workLogs: { upserts: logs, ids: logs.map((log) => log.id) },
              tasks: { upserts: tasks, ids: tasks.map((item) => item.id) },
            }),
          );
        }
        return pull(query);
      };
      servers.set(userId, created);
      api = created;
    }
    return api;
  }

  function boot() {
    return createOfflineSessionFactory({
      async openDatabase(userId): Promise<OfflineDatabase> {
        // A new handle on the same stored tables (as reopening the SQLite file would give).
        const db = createMemoryDatabase();
        const existing = databases.get(userId);
        if (existing) {
          for (const [table, rows] of Object.entries(existing.dump())) {
            for (const [key, value] of Object.entries(rows)) {
              await db.put(table as Parameters<typeof db.put>[0], key, value);
            }
          }
        }
        databases.set(userId, db);
        return db;
      },
      async deleteDatabase(userId) {
        deleted.push(userId);
        databases.delete(userId);
      },
      photoFiles: files,
      kept: createKeptUsersRegister(kv),
      legacy: kv,
      newId: idSequence('e'),
      clock: () => now,
      photoLimitBytes: options.photoLimitBytes,
      createEngine: (parts) =>
        createSyncEngine(
          {
            userId: parts.userId,
            store: parts.store,
            queue: parts.queue,
            photos: parts.photos,
            api: server(parts.userId).asClient(),
            network: net,
            clock: () => now,
            retry: ceilingRetry,
            onNeedsSignIn: () => needsSignIn.push(parts.userId),
          },
          {
            put: (photo) => async () => {
              puts.push(photo.localId);
              return { ok: true };
            },
            scheduler: new ManualScheduler(),
          },
        ),
    });
  }

  function repositoriesOf(session: AppOfflineSession) {
    return createOfflineRepositories({
      user: { id: session.userId, organizationId: ORG },
      store: session.store,
      queue: session.queue,
      photos: session.photos,
      client: {
        workLogs: { get: async () => ({ ok: false, failure: network }) },
        tasks: { get: async () => ({ ok: false, failure: network }) },
        notifications: {},
      } as never,
      newId: idSequence('f'),
      clock: () => now,
    });
  }

  /** Photo files of a user still on the phone. */
  const photosOf = (userId: string) =>
    [...files.files.keys()].filter((uri) => uri.includes(`/offline-photos/${userId}/`));

  /** A picked photo, where the image picker left it. */
  function pick(localId: string, sizeBytes = 1000) {
    files.seed(photo(localId).uri, sizeBytes);
    return photo(localId, sizeBytes);
  }

  return {
    boot,
    server,
    repositoriesOf,
    photosOf,
    pick,
    net,
    deleted,
    needsSignIn,
    puts,
    secure,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

const user = (id: string): AuthUser => ({
  id,
  organizationId: ORG,
  organizationName: 'Demo',
  displayName: 'Worker',
  email: null,
  phone: null,
  username: id.slice(0, 4),
  roles: ['worker'],
  role: 'worker',
});

describe('offline journey: nothing lost, nothing duplicated', () => {
  it('a log with two photos and a task change made offline survive a restart and are sent once', async () => {
    const device = phone();
    device.net.set(false);
    const api = device.server(USER_A);
    api.tasks.set('task-1', task({ version: 1 }));

    const first = await device.boot().open(USER_A);
    await first.store.upsert('tasks', [task({ version: 1 })]);
    const repos = device.repositoriesOf(first);
    const created = await repos.workLogs.create(createBody({ clientId: 'c1' }), [
      device.pick('p1'),
      device.pick('p2'),
    ]);
    expect(created).toMatchObject({ ok: true, data: { sync: 'pending' } });
    expect(await repos.tasks.changeStatus('task-1', { status: 'in_progress' })).toMatchObject({
      ok: true,
    });
    expect((await first.engine.syncNow('manual')).stoppedBecause).toBe('offline');
    expect(api.calls).toEqual([]);

    // The app is killed (no clean close) and started again, still offline.
    const second = await device.boot().open(USER_A);
    const kinds = (await second.queue.list()).map((item) => [item.mutation.kind, item.state]);
    expect(kinds).toEqual([
      ['createWorkLog', 'pending'],
      ['uploadAttachment', 'pending'],
      ['uploadAttachment', 'pending'],
      ['changeTaskStatus', 'pending'],
    ]);
    expect(device.photosOf(USER_A)).toHaveLength(2);

    device.net.set(true);
    const result = await second.engine.syncNow('reconnect');
    expect(result).toMatchObject({ sent: 4, failedPermanent: 0, failedRetryable: 0 });
    expect(api.callsTo('workLogs.create')).toHaveLength(1);
    expect(api.callsTo('attachments.startUpload')).toHaveLength(2);
    expect(api.callsTo('attachments.complete')).toHaveLength(2);
    expect(api.tasks.get('task-1')?.status).toBe('in_progress');
    // The declared photo ids of the create are the ones the uploads used.
    const declared = (api.callsTo('workLogs.create')[0]?.body as { attachmentClientIds: string[] })
      .attachmentClientIds;
    const uploaded = api
      .callsTo('attachments.startUpload')
      .map((call) => (call.body as { clientId: string }).clientId);
    expect(uploaded).toEqual(declared);
    // Uploaded photos leave the phone; the queue is empty.
    expect(device.photosOf(USER_A)).toEqual([]);
    expect(await second.queue.pendingCount()).toBe(0);

    // Another run (and another restart) sends nothing again.
    await second.engine.syncNow('manual');
    const third = await device.boot().open(USER_A);
    await third.engine.syncNow('manual');
    expect(api.callsTo('workLogs.create')).toHaveLength(1);
    expect(api.logsByClientId.size).toBe(1);
  });

  it('a crash after the server stored the log resends it once with the same key and clientId', async () => {
    const device = phone();
    const api = device.server(USER_A);
    const session = await device.boot().open(USER_A);
    await device.repositoriesOf(session).workLogs.create(createBody({ clientId: 'c1' }));
    const [item] = await session.queue.list();
    await session.queue.markSending(item!.id, T0);
    // The server committed the create, then the app died before the answer arrived.
    await api.client.workLogs.create(
      { clientId: 'c1' },
      { headers: { [IDEMPOTENCY_KEY_HEADER]: item!.idempotencyKey } },
    );

    const restarted = await device.boot().open(USER_A);
    expect((await restarted.queue.list()).map((left) => left.state)).toEqual(['pending']);
    await restarted.engine.syncNow('start');

    const creates = api.callsTo('workLogs.create');
    expect(creates).toHaveLength(2);
    expect(creates.map((call) => call.headers[IDEMPOTENCY_KEY_HEADER])).toEqual([
      item!.idempotencyKey,
      item!.idempotencyKey,
    ]);
    expect(api.logsByClientId.size).toBe(1);
    expect(await restarted.queue.pendingCount()).toBe(0);
  });

  it('a double save and a double "Sync now" create one log', async () => {
    const device = phone();
    const api = device.server(USER_A);
    const session = await device.boot().open(USER_A);
    const repos = device.repositoriesOf(session);
    const p1 = device.pick('p1');
    await Promise.all([
      repos.workLogs.create(createBody({ clientId: 'c1' }), [p1]),
      repos.workLogs.create(createBody({ clientId: 'c1' }), [p1]),
    ]);
    expect(await session.queue.pendingCount()).toBe(2);

    await Promise.all([session.engine.syncNow('manual'), session.engine.syncNow('manual')]);

    expect(api.callsTo('workLogs.create')).toHaveLength(1);
    expect(api.callsTo('attachments.startUpload')).toHaveLength(1);
    expect(api.logsByClientId.size).toBe(1);
  });
});

describe('offline journey: ordering per record', () => {
  it('a refused create holds back its photos only; resubmitted as new it is sent with them', async () => {
    const device = phone();
    const api = device.server(USER_A);
    const session = await device.boot().open(USER_A);
    const repos = device.repositoriesOf(session);
    await repos.workLogs.create(createBody({ clientId: 'old' }), [device.pick('p1')]);
    await repos.workLogs.create(createBody({ clientId: 'ok' }), [device.pick('p2')]);
    api.interceptor = (call) =>
      call.endpoint === 'workLogs.create' && (call.body as { clientId: string }).clientId === 'old'
        ? httpFailure('occurred_at_out_of_range')
        : undefined;

    const result = await session.engine.syncNow('manual');

    expect(result).toMatchObject({ sent: 2, failedPermanent: 1 });
    // The other log and its photo went; the refused log's photo was never started.
    expect(api.callsTo('attachments.startUpload')).toHaveLength(1);
    expect(api.logsByClientId.has('ok')).toBe(true);
    const left = await session.queue.list();
    expect(left.map((item) => [item.mutation.kind, item.state])).toEqual([
      ['createWorkLog', 'failed_permanent'],
      ['uploadAttachment', 'pending'],
    ]);
    expect(left[0]?.lastError).toMatchObject({ code: 'occurred_at_out_of_range', status: 422 });
    expect(device.photosOf(USER_A)).toHaveLength(1);

    // Kept across a restart, with its reason.
    const restarted = await device.boot().open(USER_A);
    const kept = await restarted.queue.list();
    expect(kept[0]).toMatchObject({
      state: 'failed_permanent',
      lastError: { code: 'occurred_at_out_of_range' },
    });

    api.interceptor = null;
    const renewed = await restarted.queue.resubmitAsNew(kept[0]!.id, T0);
    await restarted.engine.syncNow('manual');
    const newClientId = (renewed.mutation as { body: { clientId: string } }).body.clientId;
    expect(api.logsByClientId.has(newClientId)).toBe(true);
    expect(api.logsByClientId.has('old')).toBe(false);
    expect(api.callsTo('attachments.startUpload')).toHaveLength(2);
    expect(await restarted.queue.pendingCount()).toBe(0);
    expect(device.photosOf(USER_A)).toEqual([]);
  });
});

describe('offline journey: conflicts keep the worker’s version', () => {
  async function syncedLog(device: ReturnType<typeof phone>) {
    const api = device.server(USER_A);
    const log = workLog({ id: 'l1', clientId: 'c1', version: 1, text: 'server text' });
    api.logsById.set(log.id, log);
    api.logsByClientId.set(log.clientId, log);
    const session = await device.boot().open(USER_A);
    await session.engine.syncNow('manual'); // caches the log
    expect(await session.store.get('workLogs', 'l1')).toMatchObject({ version: 1 });
    return { api, session, repos: device.repositoriesOf(session) };
  }

  it.each(['already_reviewed', 'version_conflict', 'edit_window_closed'] as const)(
    'an edit refused with %s stays failed with the worker’s text; resubmit as new sends it',
    async (code) => {
      const device = phone();
      const { api, session, repos } = await syncedLog(device);
      device.net.set(false);
      expect(await repos.workLogs.update('l1', { text: 'my offline text' })).toMatchObject({
        ok: true,
      });
      device.net.set(true);
      api.interceptor = (call) =>
        call.endpoint === 'workLogs.update' ? httpFailure(code) : undefined;

      await session.engine.syncNow('reconnect');

      const [failed] = await session.queue.list();
      expect(failed).toMatchObject({
        state: 'failed_permanent',
        lastError: { code },
        mutation: { kind: 'updateWorkLog', body: { text: 'my offline text', expectedVersion: 1 } },
      });
      expect(api.logsById.get('l1')?.text).toBe('server text');

      await session.queue.resubmitAsNew(failed!.id, T0);
      await session.engine.syncNow('manual');
      const created = api.callsTo('workLogs.create');
      expect(created).toHaveLength(1);
      expect(created[0]?.body).toMatchObject({ text: 'my offline text' });
      expect((created[0]?.body as { clientId: string }).clientId).not.toBe('c1');
      expect(await session.queue.pendingCount()).toBe(0);
    },
  );

  it('a refused task status change can be discarded; nothing else is removed', async () => {
    const device = phone();
    const api = device.server(USER_A);
    api.tasks.set('task-1', task({ version: 1 }));
    const session = await device.boot().open(USER_A);
    await session.engine.syncNow('manual');
    const repos = device.repositoriesOf(session);
    await repos.tasks.changeStatus('task-1', { status: 'done' });
    await repos.workLogs.create(createBody({ clientId: 'c2' }));
    api.interceptor = (call) =>
      call.endpoint === 'tasks.changeStatus' ? httpFailure('task_cancelled') : undefined;

    await session.engine.syncNow('manual');

    const [failed] = await session.queue.list();
    expect(failed).toMatchObject({
      state: 'failed_permanent',
      lastError: { code: 'task_cancelled' },
    });
    await session.queue.discard(failed!.id);
    expect(await session.queue.pendingCount()).toBe(0);
    expect(api.logsByClientId.has('c2')).toBe(true);
  });
});

describe('offline journey: sessions and users on one phone', () => {
  it('token expiry offline keeps the queue; the same user signing in again resumes it', async () => {
    const device = phone();
    const api = device.server(USER_A);
    const session = await device.boot().open(USER_A);
    await device
      .repositoriesOf(session)
      .workLogs.create(createBody({ clientId: 'c1' }), [device.pick('p1')]);
    api.interceptor = () => httpFailure('unauthenticated');

    expect((await session.engine.syncNow('manual')).stoppedBecause).toBe('needsSignIn');
    expect(device.needsSignIn).toEqual([USER_A]);
    expect(api.logsByClientId.size).toBe(0);

    // The app is closed while signed out, then A signs in again.
    api.interceptor = null;
    const again = await device.boot().open(USER_A);
    expect(await again.queue.pendingCount()).toBe(2);
    expect(device.photosOf(USER_A)).toHaveLength(1);
    expect((await again.engine.syncNow('start')).sent).toBe(2);
    expect(api.logsByClientId.has('c1')).toBe(true);
  });

  it('user B never sees or sends user A’s queue, cache or photos; A’s data resumes for A', async () => {
    const device = phone();
    const apiA = device.server(USER_A);
    const apiB = device.server(USER_B);
    const factory = device.boot();
    const a = await factory.open(USER_A);
    await a.store.upsert('tasks', [task()]);
    await device
      .repositoriesOf(a)
      .workLogs.create(createBody({ clientId: 'a-log' }), [device.pick('pa')]);

    // A's session expired; B signs in on the same phone.
    const b = await factory.open(USER_B);
    expect(await b.queue.list()).toEqual([]);
    expect(await b.store.list('tasks')).toEqual([]);
    expect(await b.photos.totalBytes()).toBe(0);
    await device.repositoriesOf(b).workLogs.create(createBody({ clientId: 'b-log' }));
    await b.engine.syncNow('manual');
    expect(
      apiB.callsTo('workLogs.create').map((call) => (call.body as { clientId: string }).clientId),
    ).toEqual(['b-log']);
    expect(apiB.callsTo('attachments.startUpload')).toEqual([]);
    expect(apiA.calls).toEqual([]);
    // Opening B swept B's orphan photos only: A's queued photo is still there.
    expect(device.photosOf(USER_A)).toHaveLength(1);

    const back = await factory.open(USER_A);
    expect(await back.queue.pendingCount()).toBe(2);
    await back.engine.syncNow('manual');
    expect(apiA.logsByClientId.has('a-log')).toBe(true);
    expect(apiA.callsTo('attachments.startUpload')).toHaveLength(1);
    expect(apiA.logsByClientId.has('b-log')).toBe(false);
  });
});

describe('offline journey: sign-out with queued writes', () => {
  async function withQueuedLog() {
    const device = phone();
    const api = device.server(USER_A);
    const factory = device.boot();
    const session = await factory.open(USER_A);
    await device
      .repositoriesOf(session)
      .workLogs.create(createBody({ clientId: 'c1' }), [device.pick('p1')]);
    const identity = createOfflineIdentityStore({
      getItemAsync: async (key) => device.secure.get(key) ?? null,
      setItemAsync: async (key, value) => {
        device.secure.set(key, value);
      },
      deleteItemAsync: async (key) => {
        device.secure.delete(key);
      },
    });
    await identity.save(user(USER_A));
    const signOut = (choice: SignOutChoice | null) =>
      signOutWithChoice(
        {
          user: user(USER_A),
          queue: session.queue,
          engine: session.engine,
          factory,
          identity,
          endSession: async () => ({ ok: true }) as never,
        },
        choice,
      );
    return { device, api, factory, session, signOut };
  }

  it('without a choice nothing happens; "sync first" offline keeps everything', async () => {
    const { device, signOut } = await withQueuedLog();
    expect(await signOut(null)).toMatchObject({ ok: false, reason: 'needsChoice', pending: 2 });
    device.net.set(false);
    expect(await signOut('syncFirst')).toMatchObject({ ok: false, reason: 'notEmpty', pending: 2 });
    expect(device.deleted).toEqual([]);
    expect(device.photosOf(USER_A)).toHaveLength(1);
    expect(device.secure.size).toBe(1);
  });

  it('"sync first" online sends the queue, then deletes the database and photos', async () => {
    const { device, api, signOut } = await withQueuedLog();
    expect(await signOut('syncFirst')).toEqual({ ok: true });
    expect(api.logsByClientId.has('c1')).toBe(true);
    expect(api.callsTo('attachments.complete')).toHaveLength(1);
    expect(device.deleted).toEqual([USER_A]);
    expect(device.photosOf(USER_A)).toEqual([]);
  });

  it('"discard" deletes queue, database and photos and sends nothing', async () => {
    const { device, api, signOut } = await withQueuedLog();
    expect(await signOut('discard')).toEqual({ ok: true });
    expect(api.calls).toEqual([]);
    expect(device.deleted).toEqual([USER_A]);
    expect(device.photosOf(USER_A)).toEqual([]);
  });

  it('"keep for later" keeps queue and photos for A’s next sign-in', async () => {
    const { device, api, factory, signOut } = await withQueuedLog();
    expect(await signOut('keepForLater')).toEqual({ ok: true });
    expect(device.deleted).toEqual([]);
    expect(device.photosOf(USER_A)).toHaveLength(1);
    const back = await factory.open(USER_A);
    expect(await back.queue.pendingCount()).toBe(2);
    await back.engine.syncNow('manual');
    expect(api.logsByClientId.has('c1')).toBe(true);
  });

  it('a queue holding only refused items still needs a choice (never dropped silently)', async () => {
    const { device, api, session, signOut } = await withQueuedLog();
    api.interceptor = (call) =>
      call.endpoint === 'workLogs.create' ? httpFailure('validation_failed') : undefined;
    await session.engine.syncNow('manual');
    expect((await session.queue.counts()).failed_permanent).toBe(1);
    expect(await signOut(null)).toMatchObject({ ok: false, reason: 'needsChoice', failed: 1 });
    expect(await signOut('syncFirst')).toMatchObject({ ok: false, reason: 'notEmpty' });
    expect(device.deleted).toEqual([]);
  });
});

describe('offline journey: local photo storage limit', () => {
  it('warns at 80 %, refuses past the limit, and frees the space after the upload', async () => {
    const device = phone({ photoLimitBytes: 1000 });
    const session = await device.boot().open(USER_A);
    const repos = device.repositoriesOf(session);
    device.net.set(false);
    await repos.workLogs.create(createBody({ clientId: 'c1' }), [
      device.pick('p1', 400),
      device.pick('p2', 400),
    ]);
    expect(await session.photos.usage()).toEqual({
      usedBytes: 800,
      limitBytes: 1000,
      level: 'warning',
    });
    const refused = await repos.workLogs.create(createBody({ clientId: 'c2' }), [
      device.pick('p3', 400),
    ]);
    expect(refused).toMatchObject({ ok: false, error: { message: PHOTO_STORAGE_FULL } });
    expect(await session.queue.pendingCount()).toBe(3);

    device.net.set(true);
    await session.engine.syncNow('manual');
    expect((await session.photos.usage()).level).toBe('ok');
    expect(
      (await repos.workLogs.create(createBody({ clientId: 'c2' }), [device.pick('p3', 400)])).ok,
    ).toBe(true);
  });
});
