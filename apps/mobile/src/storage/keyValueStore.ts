/**
 * The small key-value storage the app keeps non-secret state in: the work log draft and the
 * queue of photos still to upload (`deviceStore.ts` is the AsyncStorage one). Never put a token
 * or a password here: those live in SecureStore only (`src/auth/token-storage.ts`).
 */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /** Every key (AsyncStorage has it): lets the retention sweep find every user's data. */
  getAllKeys?(): Promise<readonly string[]>;
}

/** An in-memory store for tests. */
export function createMemoryStore(initial: Record<string, string> = {}): KeyValueStore & {
  dump(): Record<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
    getAllKeys: async () => [...data.keys()],
    dump: () => Object.fromEntries(data),
  };
}
