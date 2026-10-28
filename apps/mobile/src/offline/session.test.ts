import type { AuthState, AuthUser } from '@ops/shared';

import { draftKey, editDraftKey } from '../storage/draftStore';
import { createMemoryStore } from '../storage/keyValueStore';
import { createMemoryDatabase, type OfflineDatabase } from './db';
import { droppedReferencesKey } from './engineNotices';
import { createKeptUsersRegister, createOfflineIdentityStore, KEPT_QUEUES_KEY } from './identity';
import { uploadQueueKey } from './legacyUploads';
import { deriveSessionView, previousUserToKeep, signOutWithChoice } from './lifecycle';
import { createMemoryPhotoFiles } from './photoStore';
import { createInertSyncEngine, createOfflineSessionFactory } from './session';
import { at, idSequence, photo, pull, T0, task, USER_A, USER_B, workLog } from './storeTestKit';
import { KEPT_QUEUE_MAX_DAYS } from './types';

jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only' }));

const DAY = 24 * 60 * 60 * 1000;

function phone(now: () => Date = () => T0) {
  const databases = new Map<string, ReturnType<typeof createMemoryDatabase>>();
  const opened: string[] = [];
  const deleted: string[] = [];
  const files = createMemoryPhotoFiles();
  const kv = createMemoryStore();
  const kept = createKeptUsersRegister(kv);
  const engines: { userId: string; stopped: boolean }[] = [];
  const factory = createOfflineSessionFactory({
    async openDatabase(userId): Promise<OfflineDatabase> {
      opened.push(userId);
      // A closed memory database cannot be reopened: keep its tables, give a fresh handle.
      const existing = databases.get(userId);
      const db = createMemoryDatabase();
      if (existing) {
        const dump = existing.dump();
        for (const [table, rows] of Object.entries(dump)) {
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
    kept,
    legacy: kv,
    newId: idSequence(),
    clock: now,
    createEngine: (parts) => {
      const engine = createInertSyncEngine(parts);
      const record = { userId: parts.userId, stopped: false };
      engines.push(record);
      return {
        ...engine,
        stop: async () => {
          record.stopped = true;
        },
      };
    },
  });
  return { factory, databases, opened, deleted, files, kv, kept, engines };
}

const taskChange = {
  kind: 'changeTaskStatus' as const,
  taskId: 't1',
  body: { status: 'done' as const },
};

describe('offline session factory', () => {
  it('opens one database per user; reopening the same user resumes their queue', async () => {
    const device = phone();
    const a = await device.factory.open(USER_A);
    await a.queue.enqueue(taskChange, T0);
    await a.close();
    expect(device.engines[0]?.stopped).toBe(true);

    const again = await device.factory.open(USER_A);
    expect(await again.queue.pendingCount()).toBe(1);
    expect(device.opened).toEqual([USER_A, USER_A]);
  });

  it('a different user gets their own database: the previous queue is never visible to them', async () => {
    const device = phone();
    const a = await device.factory.open(USER_A);
    await a.queue.enqueue(taskChange, T0);
    await a.store.applyPull(pull({ tasks: { upserts: [task()] } }), T0);

    const b = await device.factory.open(USER_B);
    expect(b.userId).toBe(USER_B);
    expect(await b.queue.list()).toEqual([]);
    expect(await b.store.list('tasks')).toEqual([]);
    // Opening B closed A (one user at a time) without deleting anything of A.
    expect(device.engines[0]).toMatchObject({ userId: USER_A, stopped: true });
    expect(await device.factory.pendingCountFor(USER_A)).toBe(1);
  });

  it('counts opens: a second handle keeps the session open until both are closed', async () => {
    const device = phone();
    const first = await device.factory.open(USER_A);
    const second = await device.factory.open(USER_A);
    await first.close();
    await first.close();
    expect(device.factory.current()?.userId).toBe(USER_A);
    expect(device.factory.current()).toBe(device.factory.current());
    await second.close();
    expect(device.factory.current()).toBeNull();
  });

  it('on open: resets interrupted sends, migrates the Phase 4 upload queue, deletes orphan photos', async () => {
    const device = phone();
    const first = await device.factory.open(USER_A);
    const { item } = await first.queue.enqueue(taskChange, T0);
    await first.queue.markSending(item.id, T0);
    await first.close();

    device.files.seed(photo('legacy').uri, 500);
    device.files.seed(`file:///documents/offline-photos/${USER_A}/orphan.jpg`, 10);
    await device.kv.setItem(
      uploadQueueKey(USER_A),
      JSON.stringify([
        {
          workLogId: 'l1',
          photo: photo('legacy', 500),
          checkpoint: { attachmentId: 'att-1', stored: false },
          failed: true,
          error: 'network',
          queuedAt: T0.toISOString(),
        },
      ]),
    );

    const session = await device.factory.open(USER_A);
    const items = await session.queue.list();
    expect(items.map((left) => [left.mutation.kind, left.state])).toEqual([
      ['changeTaskStatus', 'pending'],
      ['uploadAttachment', 'pending'],
    ]);
    expect(items[1]?.mutation).toMatchObject({
      workLogId: 'l1',
      checkpoint: { attachmentId: 'att-1', stored: false },
      photo: { localId: 'legacy', uri: `file:///documents/offline-photos/${USER_A}/legacy.jpg` },
    });
    expect(await device.kv.getItem(uploadQueueKey(USER_A))).toBeNull();
    expect([...device.files.files.keys()]).toEqual([
      `file:///documents/offline-photos/${USER_A}/legacy.jpg`,
    ]);
  });
});

describe('sign-out cleanup and the kept-queue sweep', () => {
  it('deleting a user also removes their drafts and dropped-link notices, not those of others', async () => {
    const device = phone();
    const keys = [
      draftKey(USER_A),
      editDraftKey(USER_A, 'log-1'),
      editDraftKey(USER_A, 'log-2'),
      droppedReferencesKey(USER_A),
      uploadQueueKey(USER_A),
    ];
    for (const key of keys) await device.kv.setItem(key, '{}');
    await device.kv.setItem(draftKey(USER_B), '{}');
    await device.kv.setItem(editDraftKey(USER_B, 'log-1'), '{}');
    await device.factory.signOutCleanup(USER_A, 'discard');
    for (const key of keys) expect(await device.kv.getItem(key)).toBeNull();
    expect(await device.kv.getItem(draftKey(USER_B))).toBe('{}');
    expect(await device.kv.getItem(editDraftKey(USER_B, 'log-1'))).toBe('{}');
  });

  it('with an empty queue, deletes the database and the photos', async () => {
    const device = phone();
    const session = await device.factory.open(USER_A);
    device.files.seed(`file:///documents/offline-photos/${USER_A}/x.jpg`, 1);
    await session.close();
    await device.factory.signOutCleanup(USER_A, 'keepForLater');
    expect(device.deleted).toEqual([USER_A]);
    expect(device.files.files.size).toBe(0);
    expect(await device.kept.all()).toEqual({});
  });

  it('keepForLater keeps queue and photos (cache deleted) and registers the user; discard deletes all', async () => {
    const device = phone();
    const session = await device.factory.open(USER_A);
    await session.store.applyPull(pull({ tasks: { upserts: [task()] } }), T0);
    await session.queue.enqueue(taskChange, T0);
    await device.factory.signOutCleanup(USER_A, 'keepForLater');
    expect(device.deleted).toEqual([]);
    expect(Object.keys(await device.kept.all())).toEqual([USER_A]);
    const back = await device.factory.open(USER_A);
    expect(await back.queue.pendingCount()).toBe(1);
    expect(await back.store.list('tasks')).toEqual([]);
    // Signing in again released them from the kept register.
    expect(await device.kept.all()).toEqual({});

    await device.factory.signOutCleanup(USER_A, 'discard');
    expect(device.deleted).toEqual([USER_A]);
  });

  it('sweeps users kept longer than KEPT_QUEUE_MAX_DAYS, never the open one', async () => {
    let now = T0;
    const device = phone(() => now);
    await device.kept.keep(USER_B, T0, { explicit: true });
    await device.kept.keep(USER_A, T0, { explicit: true });
    await device.factory.open(USER_A); // releases A
    await device.kept.keep(USER_A, T0, { explicit: true }); // (as if registered again)
    now = new Date(T0.getTime() + (KEPT_QUEUE_MAX_DAYS - 1) * DAY);
    expect(await device.factory.sweepAbandoned(now)).toEqual([]);
    now = new Date(T0.getTime() + (KEPT_QUEUE_MAX_DAYS + 1) * DAY);
    expect(await device.factory.sweepAbandoned(now)).toEqual([USER_B]);
    expect(device.deleted).toEqual([USER_B]);
  });

  it('never sweeps a user kept only because somebody else signed in (no explicit choice)', async () => {
    const device = phone();
    await device.kept.keep(USER_B, T0); // B's session expired, A signed in on the phone
    const later = new Date(T0.getTime() + 365 * DAY);
    expect(await device.factory.sweepAbandoned(later)).toEqual([]);
    expect(device.deleted).toEqual([]);
    // B later signs out with "keep for later": now the 30 days start.
    await device.kept.keep(USER_B, later, { explicit: true });
    expect(
      await device.factory.sweepAbandoned(
        new Date(later.getTime() + (KEPT_QUEUE_MAX_DAYS - 1) * DAY),
      ),
    ).toEqual([]);
    expect(
      await device.factory.sweepAbandoned(
        new Date(later.getTime() + (KEPT_QUEUE_MAX_DAYS + 1) * DAY),
      ),
    ).toEqual([USER_B]);
  });

  it('an interrupted cleanup is finished by the next sweep', async () => {
    const device = phone();
    await device.kept.deleteSoon(USER_B, T0);
    expect(await device.factory.sweepAbandoned(T0)).toEqual([USER_B]);
    expect(await device.kv.getItem(KEPT_QUEUES_KEY)).toBeNull();
  });
});

const userA: AuthUser = {
  id: USER_A,
  organizationId: 'org',
  organizationName: 'Demo',
  displayName: 'Ada',
  email: null,
  phone: null,
  username: 'ada',
  roles: ['worker'],
  role: 'worker',
};
const userB: AuthUser = { ...userA, id: USER_B, displayName: 'Bo', username: 'bo' };

describe('session view (offline start, sign in again)', () => {
  const signedOut = (
    notice: 'unreachable' | 'session_expired' | 'sign_out_unconfirmed' | null,
  ): AuthState => ({
    status: 'signedOut',
    notice,
  });

  it('opens signed in from the stored identity when the server is unreachable', () => {
    expect(deriveSessionView(signedOut('unreachable'), userA, null)).toEqual({
      state: { status: 'signedIn', user: userA },
      offline: true,
      needsSignIn: null,
    });
  });

  it('asks the same user to sign in again when the session is gone, keeping their data', () => {
    expect(deriveSessionView(signedOut('session_expired'), userA, null)).toMatchObject({
      state: { status: 'signedOut' },
      needsSignIn: userA,
    });
    expect(deriveSessionView(signedOut(null), userA, null).needsSignIn).toBe(userA);
  });

  it('keeps showing the signed-in screens while the session is checked again', () => {
    const previous = deriveSessionView(signedOut('unreachable'), userA, null);
    expect(deriveSessionView({ status: 'loading' }, userA, previous)).toBe(previous);
    expect(deriveSessionView({ status: 'loading' }, userA, null).state.status).toBe('loading');
    expect(deriveSessionView(signedOut(null), undefined, null).state.status).toBe('loading');
  });

  it('without an identity, signed out is signed out', () => {
    expect(deriveSessionView(signedOut('unreachable'), null, null)).toEqual({
      state: signedOut('unreachable'),
      offline: false,
      needsSignIn: null,
    });
    expect(deriveSessionView({ status: 'signedIn', user: userB }, userA, null)).toMatchObject({
      state: { status: 'signedIn', user: userB },
      offline: false,
    });
  });

  it('another user signing in keeps (never sends) the previous user’s data', () => {
    expect(previousUserToKeep(userA, userB)).toBe(USER_A);
    expect(previousUserToKeep(userA, userA)).toBeNull();
    expect(previousUserToKeep(null, userA)).toBeNull();
  });
});

describe('sign-out with queued writes', () => {
  function setup(pending: number, afterSync = pending) {
    const secure = new Map<string, string>([['ops.auth.offlineIdentity', JSON.stringify(userA)]]);
    const identity = createOfflineIdentityStore({
      getItemAsync: async (key) => secure.get(key) ?? null,
      setItemAsync: async (key, value) => {
        secure.set(key, value);
      },
      deleteItemAsync: async (key) => {
        secure.delete(key);
      },
    });
    let count = pending;
    const calls: string[] = [];
    const deps = {
      user: userA,
      queue: {
        pendingCount: async () => count,
        counts: async () => ({
          pending: count,
          sending: 0,
          failed_retryable: 0,
          failed_permanent: 0,
          done: 0,
        }),
      },
      engine: {
        syncNow: async () => {
          calls.push('sync');
          count = afterSync;
          return {
            sent: 0,
            failedRetryable: 0,
            failedPermanent: 0,
            pulled: true,
            stoppedBecause: null,
          };
        },
      },
      factory: {
        signOutCleanup: async (userId: string, choice: string) => {
          calls.push(`cleanup:${userId}:${choice}`);
        },
      },
      identity,
      endSession: jest.fn(async () => {
        calls.push('endSession');
        return { ok: true as const };
      }),
    };
    return { deps, calls, secure };
  }

  it('an empty queue signs out and deletes the user’s offline data and identity', async () => {
    const { deps, calls, secure } = setup(0);
    expect(await signOutWithChoice(deps, null)).toEqual({ ok: true });
    expect(calls).toEqual(['endSession', `cleanup:${USER_A}:discard`]);
    expect(secure.size).toBe(0);
  });

  it('queued writes need an explicit choice; nothing happens without one', async () => {
    const { deps, calls, secure } = setup(2);
    expect(await signOutWithChoice(deps, null)).toEqual({
      ok: false,
      reason: 'needsChoice',
      pending: 2,
      failed: 0,
    });
    expect(calls).toEqual([]);
    expect(secure.size).toBe(1);
  });

  it('sync first signs out only when the queue is empty afterwards', async () => {
    const stuck = setup(2, 1);
    expect(await signOutWithChoice(stuck.deps, 'syncFirst')).toMatchObject({
      ok: false,
      reason: 'notEmpty',
      pending: 1,
    });
    expect(stuck.calls).toEqual(['sync']);

    const done = setup(2, 0);
    expect(await signOutWithChoice(done.deps, 'syncFirst')).toEqual({ ok: true });
    expect(done.calls).toEqual(['sync', 'endSession', `cleanup:${USER_A}:discard`]);
  });

  it('keep for later and discard pass the choice to the cleanup', async () => {
    const keep = setup(3);
    await signOutWithChoice(keep.deps, 'keepForLater');
    expect(keep.calls).toEqual(['endSession', `cleanup:${USER_A}:keepForLater`]);
    const discard = setup(3);
    await signOutWithChoice(discard.deps, 'discard');
    expect(discard.calls).toEqual(['endSession', `cleanup:${USER_A}:discard`]);
  });

  it('an unconfirmed sign-out everywhere deletes nothing and keeps the identity', async () => {
    const { deps, calls, secure } = setup(0);
    deps.endSession.mockResolvedValueOnce({
      ok: false,
      failure: { reason: 'network', message: 'x', details: [] },
    } as never);
    expect(await signOutWithChoice(deps, null)).toMatchObject({ ok: false, reason: 'auth' });
    expect(calls).toEqual([]);
    expect(JSON.parse(secure.get('ops.auth.offlineIdentity') ?? 'null')).toEqual(userA);
  });
});

describe('kept-users register and identity store', () => {
  it('keeps the earliest date and releases on sign-in', async () => {
    const kept = createKeptUsersRegister(createMemoryStore());
    await kept.keep(USER_A, T0);
    await kept.keep(USER_A, at(60));
    expect((await kept.all())[USER_A]?.since).toBe(T0.toISOString());
    await kept.release(USER_A);
    expect(await kept.all()).toEqual({});
  });

  it('drops a damaged identity instead of trusting it', async () => {
    const secure = new Map([['ops.auth.offlineIdentity', '{"id":1}']]);
    const identity = createOfflineIdentityStore({
      getItemAsync: async (key) => secure.get(key) ?? null,
      setItemAsync: async () => undefined,
      deleteItemAsync: async (key) => {
        secure.delete(key);
      },
    });
    expect(identity.current()).toBeUndefined();
    expect(await identity.load()).toBeNull();
    expect(identity.current()).toBeNull();
    expect(secure.size).toBe(0);
    await identity.save(userA);
    expect(identity.current()).toEqual(userA);
  });

  it('the work logs of one user are not in another user’s database', async () => {
    const device = phone();
    const a = await device.factory.open(USER_A);
    await a.store.upsert('workLogs', [workLog({ authorId: USER_A })]);
    const b = await device.factory.open(USER_B);
    expect(await b.store.list('workLogs')).toEqual([]);
  });
});
