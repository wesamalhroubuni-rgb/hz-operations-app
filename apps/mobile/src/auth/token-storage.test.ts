import * as SecureStore from 'expo-secure-store';

import { createSecureTokenStorage, TOKEN_STORAGE_KEY, type SecureStoreLike } from './token-storage';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const TOKENS = {
  accessToken: 'access-example',
  refreshToken: 'refresh-example',
  refreshTokenExpiresAt: '2026-11-12T10:00:00.000Z',
};

function fakeStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const store: jest.Mocked<SecureStoreLike> = {
    getItemAsync: jest.fn(async (key) => items.get(key) ?? null),
    setItemAsync: jest.fn(async (key, value) => {
      items.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => {
      items.delete(key);
    }),
  };
  return { store, items };
}

describe('createSecureTokenStorage', () => {
  it('returns null when nothing is stored', async () => {
    const { store } = fakeStore();
    expect(await createSecureTokenStorage(store).load()).toBeNull();
  });

  it('saves the pair under one key and loads it back', async () => {
    const { store, items } = fakeStore();
    const storage = createSecureTokenStorage(store);

    await storage.save(TOKENS);

    expect([...items.keys()]).toEqual([TOKEN_STORAGE_KEY]);
    expect(await storage.load()).toEqual(TOKENS);
  });

  it('keeps the tokens on this device only, readable only while it is unlocked', async () => {
    const { store } = fakeStore();
    const storage = createSecureTokenStorage(store);
    const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

    await storage.save(TOKENS);
    await storage.load();
    await storage.clear();

    expect(store.setItemAsync).toHaveBeenCalledWith(TOKEN_STORAGE_KEY, expect.any(String), options);
    expect(store.getItemAsync).toHaveBeenCalledWith(TOKEN_STORAGE_KEY, options);
    expect(store.deleteItemAsync).toHaveBeenCalledWith(TOKEN_STORAGE_KEY, options);
  });

  it('clears the entry', async () => {
    const { store, items } = fakeStore({ [TOKEN_STORAGE_KEY]: JSON.stringify(TOKENS) });
    await createSecureTokenStorage(store).clear();
    expect(items.size).toBe(0);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON of another shape', JSON.stringify({ accessToken: 'only-this' })],
    ['JSON null', 'null'],
  ])('treats %s as no session and removes it', async (_name, raw) => {
    const { store, items } = fakeStore({ [TOKEN_STORAGE_KEY]: raw });
    expect(await createSecureTokenStorage(store).load()).toBeNull();
    expect(items.size).toBe(0);
  });

  it('lets a failure of the secure store reach the session manager, which copes', async () => {
    const { store } = fakeStore();
    store.setItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));
    await expect(createSecureTokenStorage(store).save(TOKENS)).rejects.toThrow(
      'keystore unavailable',
    );
  });

  it('uses expo-secure-store by default', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(JSON.stringify(TOKENS));
    expect(await createSecureTokenStorage().load()).toEqual(TOKENS);
  });
});
