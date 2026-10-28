import { uploadQueueKey } from '../offline/legacyUploads';
import { draftKey, editDraftKey, isDraftStale } from './draftStore';
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

function legacyQueued(id: string, queuedAt: string) {
  return {
    workLogId: 'log-1',
    photo: photo(id),
    checkpoint: { attachmentId: null, stored: false },
    failed: false,
    error: null,
    queuedAt,
  };
}

describe('retention of drafts', () => {
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
  });

  it('deletes stale new-log and edit drafts of every user, but never a queued upload (no age limit)', async () => {
    const store = createMemoryStore({
      [draftKey('user-a')]: draft(ago(30), [photo('draft-a')]),
      [draftKey('user-b')]: draft(ago(2), [photo('draft-b')]),
      [editDraftKey('user-a', 'log-9')]: draft(ago(20), [photo('edit-a')]),
      [uploadQueueKey('user-a')]: JSON.stringify([legacyQueued('q-old', ago(40))]),
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
    expect(result).toEqual({ drafts: 2 });
    expect(Object.keys(store.dump()).sort()).toEqual(
      [draftKey('user-b'), uploadQueueKey('user-a'), 'ops.other.setting'].sort(),
    );
    expect(deleted.sort()).toEqual([photo('draft-a').uri, photo('edit-a').uri].sort());
  });

  it('never deletes a file a not-yet-migrated upload still needs, and survives a broken store', async () => {
    const shared = photo('shared');
    const store = createMemoryStore({
      [draftKey('user-a')]: draft(ago(30), [shared]),
      [uploadQueueKey('user-a')]: JSON.stringify([{ ...legacyQueued('x', ago(1)), photo: shared }]),
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
    ).resolves.toEqual({ drafts: 0 });
  });
});
