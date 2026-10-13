import { AsyncLocalStorage } from 'node:async_hooks';

/** The identity a request acts as. */
export interface RequestActor {
  userId: string;
  organizationId: string;
}

export interface RequestContextStore {
  /** Identifier of the request, echoed in the `x-request-id` response header, logs and audit. */
  correlationId: string;
  /** Null until an authentication step sets it (the dev header today, real sign-in in Phase 3). */
  actor: RequestActor | null;
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

  setActor(actor: RequestActor): void {
    const store = storage.getStore();
    if (!store) {
      throw new Error('RequestContext.setActor called outside a request context');
    }
    store.actor = actor;
  },
};
