import { createMemoryDatabase } from './db';
import { createLocalStore } from './localStore';
import { createLocalPhotoStore, createMemoryPhotoFiles, photoStorageLevel } from './photoStore';
import {
  at,
  memoryLayer,
  notification,
  ORGANIZATION,
  photo,
  pull,
  T0,
  task,
  USER_A,
  USER_B,
  workLog,
} from './storeTestKit';
import { DEFAULT_PHOTO_STORAGE_LIMIT_BYTES } from './types';

describe('local store: applying pulls', () => {
  it('a full pull replaces the cache and stores cursor, server time, organization and refresh time', async () => {
    const { store } = memoryLayer();
    await store.upsert('tasks', [task({ id: 'stale' })]);
    await store.applyPull(pull({ tasks: { upserts: [task({ id: 't1' })] } }), at(1));
    expect((await store.list('tasks')).map((item) => item.id)).toEqual(['t1']);
    expect(await store.getSyncMeta()).toEqual({
      cursor: 'cursor-1',
      lastRefreshedAt: at(1).toISOString(),
      lastServerTime: T0.toISOString(),
      organization: ORGANIZATION,
    });
  });

  it('a delta pull upserts changes and prunes every record whose id is no longer listed', async () => {
    const { store } = memoryLayer();
    await store.applyPull(
      pull({
        tasks: { upserts: [task({ id: 't1' }), task({ id: 't2' })] },
        workLogs: {
          upserts: [workLog({ id: 'l1', clientId: 'c1' }), workLog({ id: 'l2', clientId: 'c2' })],
        },
        notifications: { upserts: [notification({ id: 'n1' })] },
      }),
      at(1),
    );
    // t2 was reassigned away, l2 archived; t1 changed; n1 unchanged (not in upserts, still listed).
    await store.applyPull(
      pull(
        {
          tasks: { upserts: [task({ id: 't1', status: 'done' })], ids: ['t1'] },
          workLogs: { upserts: [], ids: ['l1'] },
          notifications: { upserts: [], ids: ['n1'] },
        },
        false,
        'cursor-2',
      ),
      at(2),
    );
    expect(await store.list('tasks')).toEqual([task({ id: 't1', status: 'done' })]);
    expect((await store.list('workLogs')).map((log) => log.id)).toEqual(['l1']);
    expect((await store.list('notifications')).map((item) => item.id)).toEqual(['n1']);
    expect((await store.getSyncMeta()).cursor).toBe('cursor-2');
  });

  it('reports ids that are neither cached nor sent', async () => {
    const { store } = memoryLayer();
    const report = await store.applyPullWithReport(
      pull({ tasks: { upserts: [], ids: ['ghost'] } }, false),
      at(1),
    );
    expect(report.missingIds).toBe(1);
  });

  it('finds an offline-created log by clientId, and notifies subscribers per resource', async () => {
    const { store } = memoryLayer();
    const changed: string[] = [];
    store.subscribe((resource) => changed.push(resource));
    await store.upsert('workLogs', [workLog({ id: 'l9', clientId: 'c9' })]);
    expect((await store.getWorkLogByClientId('c9'))?.id).toBe('l9');
    expect(await store.getWorkLogByClientId('nope')).toBeNull();
    expect(changed).toEqual(['workLogs']);
  });

  it('clearCache deletes the reads and the sync meta but not the queue', async () => {
    const { store, queue } = memoryLayer();
    await store.applyPull(pull({ tasks: { upserts: [task()] } }), at(1));
    await queue.enqueue(
      { kind: 'changeTaskStatus', taskId: 'task-1', body: { status: 'done' } },
      at(2),
    );
    await store.clearCache();
    expect(await store.list('tasks')).toEqual([]);
    expect((await store.getSyncMeta()).lastRefreshedAt).toBeNull();
    expect(await queue.pendingCount()).toBe(1);
    // The queue's counter survived: a new item still sorts after the old one.
    const next = await queue.enqueue(
      { kind: 'changeTaskStatus', taskId: 't2', body: { status: 'done' } },
      at(3),
    );
    expect(next.item.seq).toBe(2);
  });

  it('keeps each user in their own database', async () => {
    const dbA = createMemoryDatabase();
    const dbB = createMemoryDatabase();
    await createLocalStore(dbA, USER_A).upsert('tasks', [task({ id: 'secret' })]);
    expect(await createLocalStore(dbB, USER_B).list('tasks')).toEqual([]);
  });

  it('a transaction that fails leaves nothing behind', async () => {
    const db = createMemoryDatabase();
    await expect(
      db.transaction(async (tx) => {
        await tx.put('meta', 'x', '1');
        throw new Error('disk');
      }),
    ).rejects.toThrow('disk');
    expect(await db.get('meta', 'x')).toBeNull();
  });
});

describe('local photo store', () => {
  it('moves photos into the user folder and refuses one past the limit', async () => {
    const files = createMemoryPhotoFiles();
    const photos = createLocalPhotoStore(files, USER_A, 3000);
    files.seed(photo('p1').uri, 2000);
    files.seed(photo('p2').uri, 1500);
    const first = await photos.save(photo('p1', 2000));
    expect(first).toEqual({
      ok: true,
      photo: { ...photo('p1', 2000), uri: `file:///documents/offline-photos/${USER_A}/p1.jpg` },
    });
    expect(await photos.canAdd(1000)).toBe(true);
    expect(await photos.save(photo('p2', 1500))).toEqual({ ok: false, reason: 'full' });
    // The refused photo stays where it was (nothing lost).
    expect(files.files.has(photo('p2').uri)).toBe(true);
    // Saving an already stored photo again is fine.
    expect((await photos.save(first.ok ? first.photo : photo('p1'))).ok).toBe(true);
  });

  it('reports usage with a warning at 80 % and full at the limit', async () => {
    expect(photoStorageLevel(0, 100)).toBe('ok');
    expect(photoStorageLevel(79, 100)).toBe('ok');
    expect(photoStorageLevel(80, 100)).toBe('warning');
    expect(photoStorageLevel(100, 100)).toBe('full');
    const files = createMemoryPhotoFiles();
    files.seed(`file:///documents/offline-photos/${USER_A}/a.jpg`, 450 * 1024 * 1024);
    expect(await createLocalPhotoStore(files, USER_A).usage()).toEqual({
      usedBytes: 450 * 1024 * 1024,
      limitBytes: DEFAULT_PHOTO_STORAGE_LIMIT_BYTES,
      level: 'warning',
    });
  });

  it('deletes orphans and the whole folder, never another user’s files', async () => {
    const files = createMemoryPhotoFiles();
    const folder = (user: string) => `file:///documents/offline-photos/${user}/`;
    files.seed(`${folder(USER_A)}keep.jpg`, 1);
    files.seed(`${folder(USER_A)}orphan.jpg`, 1);
    files.seed(`${folder(USER_B)}theirs.jpg`, 1);
    const photos = createLocalPhotoStore(files, USER_A);
    expect(await photos.deleteAllExcept(['keep'])).toBe(1);
    expect(await photos.exists({ ...photo('keep'), uri: `${folder(USER_A)}keep.jpg` })).toBe(true);
    await photos.clear();
    expect([...files.files.keys()]).toEqual([`${folder(USER_B)}theirs.jpg`]);
  });
});
