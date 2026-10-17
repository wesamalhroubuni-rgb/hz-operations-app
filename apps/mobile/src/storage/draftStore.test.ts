import { newLogFormValues } from '../logic/logForm';
import { createDraftStore, draftKey, isDraftWorthKeeping } from './draftStore';
import { createMemoryStore, type KeyValueStore } from './keyValueStore';
import type { LocalPhoto } from './localPhoto';

const USER = 'user-1';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const photo: LocalPhoto = {
  localId: 'p1',
  uri: 'file:///docs/pending-photos/p1.jpg',
  fileName: 'photo-1.jpg',
  mimeType: 'image/jpeg',
  width: 1600,
  height: 1200,
  sizeBytes: 345_678,
};

describe('draft store', () => {
  it('keeps the form and its photos across a restart, per user', async () => {
    const memory = createMemoryStore();
    const values = {
      ...newLogFormValues(CLIENT_ID),
      text: 'Half typed',
      customFields: { count: '3', ok: true },
    };
    await createDraftStore(memory).save(
      USER,
      { values, photos: [photo] },
      new Date('2026-10-16T10:00:00Z'),
    );

    // A new store instance, as after an app restart.
    const restored = await createDraftStore(memory).load(USER);
    expect(restored).toEqual({ savedAt: '2026-10-16T10:00:00.000Z', values, photos: [photo] });
    expect(await createDraftStore(memory).load('someone-else')).toBeNull();
  });

  it('clears the draft once the log is saved', async () => {
    const memory = createMemoryStore();
    const store = createDraftStore(memory);
    await store.save(USER, { values: newLogFormValues(CLIENT_ID), photos: [] });
    await store.clear(USER);
    expect(await store.load(USER)).toBeNull();
    expect(memory.dump()).toEqual({});
  });

  it('drops a damaged or outdated draft instead of failing', async () => {
    const memory = createMemoryStore({ [draftKey(USER)]: '{not json' });
    expect(await createDraftStore(memory).load(USER)).toBeNull();
    expect(memory.dump()).toEqual({});

    const old = createMemoryStore({ [draftKey(USER)]: JSON.stringify({ version: 0, values: {} }) });
    expect(await createDraftStore(old).load(USER)).toBeNull();
  });

  it('never throws when the storage fails: the form in memory is still there', async () => {
    const broken: KeyValueStore = {
      getItem: () => Promise.reject(new Error('disk')),
      setItem: () => Promise.reject(new Error('disk')),
      removeItem: () => Promise.reject(new Error('disk')),
    };
    const store = createDraftStore(broken);
    await expect(
      store.save(USER, { values: newLogFormValues(CLIENT_ID), photos: [] }),
    ).resolves.toBeUndefined();
    await expect(store.load(USER)).resolves.toBeNull();
    await expect(store.clear(USER)).resolves.toBeUndefined();
  });
});

describe('isDraftWorthKeeping', () => {
  const prefill = { taskId: null, siteId: null, teamId: null };

  it('ignores an untouched form', () => {
    expect(isDraftWorthKeeping(newLogFormValues(CLIENT_ID), [], prefill)).toBe(false);
  });

  it('keeps anything typed, chosen or photographed', () => {
    const base = newLogFormValues(CLIENT_ID);
    expect(isDraftWorthKeeping({ ...base, text: 'x' }, [], prefill)).toBe(true);
    expect(isDraftWorthKeeping({ ...base, logTypeId: 'type' }, [], prefill)).toBe(true);
    expect(isDraftWorthKeeping({ ...base, customFields: { a: false } }, [], prefill)).toBe(true);
    expect(isDraftWorthKeeping(base, [photo], prefill)).toBe(true);
    expect(isDraftWorthKeeping({ ...base, taskId: 'task' }, [], prefill)).toBe(true);
    expect(
      isDraftWorthKeeping({ ...base, taskId: 'task' }, [], { ...prefill, taskId: 'task' }),
    ).toBe(false);
  });
});
