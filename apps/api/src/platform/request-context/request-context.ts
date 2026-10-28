import { AsyncLocalStorage } from 'node:async_hooks';

/** The identity a request acts as. */
export interface RequestActor {
  userId: string;
  organizationId: string;
  /** The session the request was authenticated with. Absent outside real sign-in (seed, jobs). */
  sessionId?: string;
}

/**
 * What a request sent by a phone's offline queue says about itself (ADR-0008): the
 * `x-client-sync: offline` header, the phone's clock (`x-device-time`) and the server's clock
 * when the request arrived. Recorded, never trusted for a rule.
 */
export interface OfflineSyncInfo {
  /** The `x-device-time` header when it is a valid ISO date-time, otherwise null. */
  deviceTime: string | null;
  /** The server clock when the request was received. */
  serverTime: Date;
  /** Phone clock minus server clock, in whole seconds; null without a valid device time. */
  clockSkewSeconds: number | null;
}

export interface RequestContextStore {
  /** Identifier of the request, echoed in the `x-request-id` response header, logs and audit. */
  correlationId: string;
  /** Null until an authentication step sets it (the platform guard). */
  actor: RequestActor | null;
  /** Set when the request came from an offline queue (`x-client-sync: offline`). */
  offlineSync?: OfflineSyncInfo | null;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Per-request state available anywhere below the HTTP layer without passing it through every
 * call. Outside a request (seed script, background job) there is no store: `correlationId()` and
 * `actor()` return null and writes are attributed to the system.
 */
export const RequestContext = {
  run<Result>(store: RequestContextStore, callback: () => Result): Result {
    return storage.run(store, callback);
  },

  current(): RequestContextStore | undefined {
    return storage.getStore();
  },

  correlationId(): string | null {
    return storage.getStore()?.correlationId ?? null;
  },

  actor(): RequestActor | null {
    return storage.getStore()?.actor ?? null;
  },

  /** The offline-sync facts of the current request, or null for an ordinary request. */
  offlineSync(): OfflineSyncInfo | null {
    return storage.getStore()?.offlineSync ?? null;
  },

  setActor(actor: RequestActor): void {
    const store = storage.getStore();
    if (!store) {
      throw new Error('RequestContext.setActor called outside a request context');
    }
    store.actor = actor;
  },
};
