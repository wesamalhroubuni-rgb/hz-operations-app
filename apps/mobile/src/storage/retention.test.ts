import { pruneStaleQueue, uploadQueueKey } from '../data/uploadQueue';
import { draftKey, isDraftStale } from './draftStore';
import { createMemoryStore } from './keyValueStore';
import type { LocalPhoto } from './localPhoto';
import { LOCAL_DATA_MAX_AGE_MS, purgeStaleLocalData } from './retention';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-17T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function photo(id: string): LocalPhoto {
  return {
    localId: id,
    uri: `file:///docs/pending-photos/${id}.jpg`,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    width: 1600,
    height: 1200,
    sizeBytes: 1000,
  };
}

function draft(savedAt: string, photos: LocalPhoto[] = []): string {
  return JSON.stringify({
    version: 1,
    savedAt,
    values: {
      clientId: 'c1',
      logTypeId: null,
      customFields: {},
      text: 'Pump at site 3 leaking',
      taskId: null,
      siteId: null,
      teamId: null,
      occurredAt: null,
      location: null,
    },
    photos,
  });
}

function queued(id: string, queuedAt?: string) {
  return {
    workLogId: 'log-1',
    photo: photo(id),
    checkpoint: { attachmentId: null, stored: false },
    failed: false,
    error: null,
    ...(queuedAt === undefined ? {} : { queuedAt }),
  };
}

describe('retention of local work data', () => {
  it('keeps 14 days', () => {
    expect(LOCAL_DATA_MAX_AGE_MS).toBe(14 * DAY);
  });

  it('isDraftStale: older than the limit or unreadable is stale, with its photos', () => {
    expect(isDraftStale(draft(ago(13)), NOW, LOCAL_DATA_MAX_AGE_MS)).toEqual({
      stale: false,
      photoUris: [],
    });
    expect(isDraftStale(draft(ago(15), [photo('a')]), NOW, LOCAL_DATA_MAX_AGE_MS)).toEqual({
      stale: true,
      photoUris: [photo('a').uri],
    });
    expect(isDraftStale('{not json', NOW, LOCAL_DATA_MAX_AGE_MS).stale).toBe(true);
    expect(isDraftStale(null, NOW, LOCAL_DATA_MAX_AGE_MS).stale).toBe(false);
  });

  it('pruneStaleQueue: drops old entries, keeps recent ones, stamps entries without a date', () => {
    const raw = JSON.stringify([queued('old', ago(20)), queued('new', ago(1)), queued('legacy')]);
    const pruned = pruneStaleQueue(raw, NOW, LOCAL_DATA_MAX_AGE_MS);
    expect(pruned.changed).toBe(true);
    expect(pruned.expiredUris).toEqual([photo('old').uri]);
    expect(pruned.keptUris).toEqual([photo('new').uri, photo('legacy').uri]);
    const kept = JSON.parse(pruned.value!) as { photo: LocalPhoto; queuedAt: string }[];
    expect(kept.map((entry) => [entry.photo.localId, entry.queuedAt])).toEqual([
      ['new', ago(1)],
      ['legacy', NOW.toISOString()],
    ]);
    // Everything old: the key goes.
    expect(
      pruneStaleQueue(JSON.stringify([queued('old', ago(15))]), NOW, LOCAL_DATA_MAX_AGE_MS),
    ).toMatchObject({ value: null, changed: true });
    // Nothing to change.
    expect(
      pruneStaleQueue(JSON.stringify([queued('new', ago(1))]), NOW, LOCAL_DATA_MAX_AGE_MS).changed,
    ).toBe(false);
  });

  it('purgeStaleLocalData: for every user of the phone, deletes stale drafts and queued photos and their files', async () => {
    const store = createMemoryStore({
      [draftKey('user-a')]: draft(ago(30), [photo('draft-a')]),
      [draftKey('user-b')]: draft(ago(2), [photo('draft-b')]),
      [uploadQueueKey('user-a')]: JSON.stringify([queued('q-old', ago(15))]),
      [uploadQueueKey('user-b')]: JSON.stringify([
        queued('q-b-old', ago(40)),
        queued('q-b-new', ago(3)),
      ]),
      'ops.other.setting': 'kept',
    });
    const deleted: string[] = [];
    const result = await purgeStaleLocalData({
      store,
      now: NOW,
      deleteLocalFile: async (uri) => {
        deleted.push(uri);
      },
    });

    expect(result).toEqual({ drafts: 1, queuedPhotos: 2 });
    const left = store.dump();
    expect(Object.keys(left).sort()).toEqual(
      [draftKey('user-b'), uploadQueueKey('user-b'), 'ops.other.setting'].sort(),
    );
    expect(
      (JSON.parse(left[uploadQueueKey('user-b')]!) as { photo: LocalPhoto }[]).map(
        (entry) => entry.photo.localId,
      ),
    ).toEqual(['q-b-new']);
    expect(deleted.sort()).toEqual(
      [photo('draft-a').uri, photo('q-old').uri, photo('q-b-old').uri].sort(),
    );
  });

  it('never deletes a file a kept queued upload still needs, and survives a broken store', async () => {
    const shared = photo('shared');
    const store = createMemoryStore({
      [draftKey('user-a')]: draft(ago(30), [shared]),
      [uploadQueueKey('user-a')]: JSON.stringify([{ ...queued('x', ago(1)), photo: shared }]),
    });
    const deleted: string[] = [];
    await purgeStaleLocalData({
      store,
      now: NOW,
      deleteLocalFile: async (uri) => {
        deleted.push(uri);
      },
    });
    expect(deleted).toEqual([]);

    const broken = {
      getItem: () => Promise.reject(new Error('disk')),
      setItem: () => Promise.reject(new Error('disk')),
      removeItem: () => Promise.reject(new Error('disk')),
      getAllKeys: () => Promise.reject(new Error('disk')),
    };
    await expect(
      purgeStaleLocalData({ store: broken, now: NOW, deleteLocalFile: async () => undefined }),
    ).resolves.toEqual({ drafts: 0, queuedPhotos: 0 });
  });
});
