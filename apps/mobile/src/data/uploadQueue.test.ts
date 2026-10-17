import type { ApiFailure, Attachment, AttachmentUploadResult, UploadFailure } from '@ops/shared';

import { createMemoryStore } from '../storage/keyValueStore';
import type { LocalPhoto } from '../storage/localPhoto';
import {
  createUploadQueue,
  uploadErrorKind,
  uploadQueueKey,
  type UploadQueueDeps,
} from './uploadQueue';

const USER = 'user-1';
const LOG = 'log-1';

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

const ready = { id: 'att', status: 'ready' } as Attachment;
const success: AttachmentUploadResult = {
  ok: true,
  attachment: ready,
  checkpoint: { attachmentId: 'att', stored: true },
};

function failure(retryable: boolean, api: ApiFailure | null = null): AttachmentUploadResult {
  return {
    ok: false,
    failure: { step: 'put', retryable, api, putStatus: retryable ? 0 : null, message: 'x' },
    checkpoint: { attachmentId: 'att', stored: false },
  };
}

/** Lets pending promise chains (the queue's awaits) finish. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Timers run by hand, so the test controls when automatic retries happen. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout: (callback: () => void) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout: (handle: unknown) => {
      pending.delete(handle as number);
    },
    runAll: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback());
    },
    count: () => pending.size,
  };
}

function setup(upload: UploadQueueDeps['upload']) {
  const store = createMemoryStore();
  const timers = manualTimers();
  const deleted: string[] = [];
  const uploaded: string[] = [];
  const queue = createUploadQueue({
    store,
    upload,
    deleteLocalFile: async (uri) => {
      deleted.push(uri);
    },
    onUploaded: (id) => uploaded.push(id),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    retryDelayMs: (attempt) => (attempt <= 2 ? 1000 : null),
  });
  return { store, timers, deleted, uploaded, queue };
}

describe('upload queue', () => {
  it('stamps every queued photo with the time it was queued (for the 14-day retention)', async () => {
    const store = createMemoryStore();
    const queue = createUploadQueue({
      store,
      upload: () => new Promise<AttachmentUploadResult>(() => undefined),
      deleteLocalFile: async () => undefined,
      now: () => new Date('2026-10-01T08:00:00.000Z'),
    });
    await queue.start(USER);
    await queue.enqueue(LOG, [photo('a')]);
    const stored = JSON.parse((await store.getItem(uploadQueueKey(USER))) ?? '[]') as {
      queuedAt: string;
    }[];
    expect(stored.map((entry) => entry.queuedAt)).toEqual(['2026-10-01T08:00:00.000Z']);
    expect(queue.getState().items[0]?.queuedAt).toBe('2026-10-01T08:00:00.000Z');
  });

  it('uploads queued photos one by one, then forgets them and deletes the local copies', async () => {
    const calls: string[] = [];
    const { queue, deleted, uploaded, store } = setup(async (item, onProgress) => {
      calls.push(item.photo.localId);
      onProgress(0.5);
      return success;
    });
    await queue.start(USER);
    await queue.enqueue(LOG, [photo('a'), photo('b')]);
    await queue.whenIdle();
    expect(calls).toEqual(['a', 'b']);
    expect(queue.getState().items).toEqual([]);
    expect(deleted).toEqual([photo('a').uri, photo('b').uri]);
    expect(uploaded).toEqual([LOG, LOG]);
    expect(JSON.parse((await store.getItem(uploadQueueKey(USER))) ?? '[]')).toEqual([]);
  });

  it('retries a retryable failure automatically, resuming from the checkpoint', async () => {
    const checkpoints: unknown[] = [];
    let attempt = 0;
    const { queue, timers } = setup(async (item) => {
      checkpoints.push(item.checkpoint);
      attempt += 1;
      return attempt === 1 ? failure(true) : success;
    });
    await queue.start(USER);
    await queue.enqueue(LOG, [photo('a')]);
    await flush();
    expect(queue.getState().items[0]).toMatchObject({
      status: 'retrying',
      attempts: 1,
      error: 'network',
    });
    expect(timers.count()).toBe(1);
    timers.runAll();
    await queue.whenIdle();
    expect(queue.getState().items).toEqual([]);
    expect(checkpoints[1]).toEqual({ attachmentId: 'att', stored: false });
  });

  it('stops retrying after the automatic attempts and waits for the worker', async () => {
    const { queue, timers } = setup(async () => failure(true));
    await queue.start(USER);
    await queue.enqueue(LOG, [photo('a')]);
    for (let round = 0; round < 3; round += 1) {
      await flush();
      timers.runAll();
    }
    await flush();
    await queue.whenIdle();
    expect(queue.getState().items[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      error: 'network',
    });
    expect(timers.count()).toBe(0);
  });

  it('does not retry a refusal, and a manual retry tries again', async () => {
    let refuse = true;
    const forbidden: ApiFailure = {
      kind: 'http',
      status: 403,
      message: 'no',
      error: {
        statusCode: 403,
        code: 'forbidden',
        message: 'no',
        correlationId: null,
        timestamp: '2026-10-16T10:00:00Z',
      },
    };
    const { queue, timers } = setup(async () => (refuse ? failure(false, forbidden) : success));
    await queue.start(USER);
    await queue.enqueue(LOG, [photo('a')]);
    await queue.whenIdle();
    expect(queue.getState().items[0]).toMatchObject({ status: 'failed', error: 'notAllowed' });
    expect(timers.count()).toBe(0);

    refuse = false;
    queue.retry(LOG);
    await queue.whenIdle();
    expect(queue.getState().items).toEqual([]);
  });

  it('survives a restart: pending photos come back for the same user and are sent', async () => {
    let online = false;
    const first = setup(async () => (online ? success : failure(false)));
    await first.queue.start(USER);
    await first.queue.enqueue(LOG, [photo('a')]);
    await first.queue.whenIdle();
    first.queue.stop();

    online = true;
    const sent: string[] = [];
    const second = createUploadQueue({
      store: first.store,
      upload: async (item) => {
        sent.push(item.photo.localId);
        return success;
      },
      deleteLocalFile: async () => undefined,
    });
    await second.start(USER);
    // A photo given up on before the restart waits for the worker's retry.
    expect(second.getState().items[0]).toMatchObject({ status: 'failed' });
    second.retry();
    await second.whenIdle();
    expect(sent).toEqual(['a']);

    const otherUser = createUploadQueue({
      store: first.store,
      upload: async () => success,
      deleteLocalFile: async () => undefined,
    });
    await otherUser.start('user-2');
    expect(otherUser.getState().items).toEqual([]);
  });

  it('discards a photo the worker gives up on', async () => {
    const { queue, deleted } = setup(async () => failure(false));
    await queue.start(USER);
    await queue.enqueue(LOG, [photo('a')]);
    await queue.whenIdle();
    await queue.discard('a');
    expect(queue.getState().items).toEqual([]);
    expect(deleted).toEqual([photo('a').uri]);
  });

  it('ignores the same photo queued twice', async () => {
    const { queue } = setup(() => new Promise(() => undefined));
    await queue.start(USER);
    await queue.enqueue(LOG, [photo('a')]);
    await queue.enqueue(LOG, [photo('a')]);
    expect(queue.getState().items).toHaveLength(1);
  });
});

describe('uploadErrorKind', () => {
  const base: UploadFailure = {
    step: 'start',
    retryable: false,
    api: null,
    putStatus: null,
    message: 'x',
  };
  const http = (status: number): ApiFailure => ({
    kind: 'http',
    status,
    message: 'x',
    error: {
      statusCode: status,
      code: 'unprocessable',
      message: 'x',
      correlationId: null,
      timestamp: '2026-10-16T10:00:00Z',
    },
  });

  it.each([
    [{ ...base, retryable: true }, 'network'],
    [{ ...base, api: http(403) }, 'notAllowed'],
    [{ ...base, api: http(404) }, 'notFound'],
    [{ ...base, api: http(422) }, 'rejected'],
    [{ ...base, step: 'put' as const, putStatus: 413 }, 'rejected'],
    [base, 'unexpected'],
  ])('%#', (failure, kind) => {
    expect(uploadErrorKind(failure)).toBe(kind);
  });
});
