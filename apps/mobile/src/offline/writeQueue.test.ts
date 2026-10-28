import { createWriteQueue, recordKeyOf } from './writeQueue';
import {
  at,
  createBody,
  idSequence,
  memoryLayer,
  photo,
  T0,
  workLog,
  USER_A,
} from './storeTestKit';
import type { QueuedMutation } from './types';

const create = (clientId = 'c1', extra = {}): QueuedMutation => ({
  kind: 'createWorkLog',
  body: createBody({ clientId, ...extra }),
});
const edit = (clientId: string, body: Record<string, unknown>): QueuedMutation => ({
  kind: 'updateWorkLog',
  workLogClientId: clientId,
  body,
});
const taskStatus = (
  taskId: string,
  status: 'in_progress' | 'done' | 'blocked',
  expectedVersion = 1,
): QueuedMutation => ({
  kind: 'changeTaskStatus',
  taskId,
  body: { status, expectedVersion },
});
const upload = (
  clientId: string,
  localId: string,
  attachmentClientId = `att-${localId}`,
): QueuedMutation => ({
  kind: 'uploadAttachment',
  workLogClientId: clientId,
  workLogId: null,
  attachmentClientId,
  photo: photo(localId),
  checkpoint: { attachmentId: null, stored: false },
});
const networkError = { code: 'network' as const, message: 'offline', status: null };

describe('write queue: ordering per record', () => {
  it('sends a record strictly in order, one item at a time, records independently', async () => {
    const { queue } = memoryLayer();
    await queue.enqueue(create('c1'), T0);
    await queue.enqueue(taskStatus('t1', 'in_progress'), at(1));
    await queue.enqueue(upload('c1', 'p1'), at(2));
    await queue.enqueue(taskStatus('t1', 'done'), at(3));

    const first = await queue.nextBatch(at(4));
    expect(first.map((item) => item.mutation.kind)).toEqual(['createWorkLog', 'changeTaskStatus']);

    // While the create is in flight, the photo of the same log waits.
    const [createItem, taskItem] = first;
    await queue.markSending(createItem!.id, at(4));
    expect((await queue.nextBatch(at(4))).map((item) => item.id)).toEqual([taskItem!.id]);

    await queue.markSending(taskItem!.id, at(4));
    await queue.markDone(createItem!.id);
    await queue.markDone(taskItem!.id);
    const second = await queue.nextBatch(at(5));
    expect(second.map((item) => item.mutation.kind)).toEqual([
      'uploadAttachment',
      'changeTaskStatus',
    ]);
    expect((second[1]!.mutation as { body: { status: string } }).body.status).toBe('done');
  });

  it('a permanent failure blocks the later items of its record only, until the worker acts', async () => {
    const { queue } = memoryLayer();
    const a = await queue.enqueue(taskStatus('t1', 'in_progress'), T0);
    await queue.enqueue(taskStatus('t1', 'done'), at(1));
    const other = await queue.enqueue(taskStatus('t2', 'done'), at(2));
    await queue.markSending(a.item.id, at(3));
    await queue.markFailed(
      a.item.id,
      { code: 'task_cancelled', message: 'x', status: 409 },
      true,
      null,
      at(3),
    );

    expect((await queue.nextBatch(at(100))).map((item) => item.id)).toEqual([other.item.id]);
    expect((await queue.get(a.item.id))?.state).toBe('failed_permanent');

    await queue.retry(a.item.id, at(101));
    expect((await queue.nextBatch(at(101))).map((item) => item.id)).toContain(a.item.id);
  });

  it('a retryable failure waits for nextAttemptAt and counts attempts', async () => {
    const { queue } = memoryLayer();
    const { item } = await queue.enqueue(taskStatus('t1', 'done'), T0);
    await queue.markSending(item.id, T0);
    await queue.markFailed(item.id, networkError, false, at(1), T0);
    expect(await queue.nextBatch(at(0.5))).toEqual([]);
    const ready = await queue.nextBatch(at(1));
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      state: 'failed_retryable',
      attempts: 1,
      lastError: networkError,
    });

    await queue.markSending(item.id, at(1));
    await queue.markFailed(item.id, networkError, false, at(60), at(1));
    expect((await queue.get(item.id))?.attempts).toBe(2);
    await queue.wakeRetries();
    expect(await queue.nextBatch(at(2))).toHaveLength(1);
  });
});

describe('write queue: no duplicates, nothing lost', () => {
  it('keeps the idempotency key and clientId fixed for every attempt', async () => {
    const { queue } = memoryLayer();
    const { item } = await queue.enqueue(create('c1'), T0);
    await queue.markSending(item.id, T0);
    await queue.markFailed(item.id, networkError, false, null, T0);
    await queue.retry(item.id, at(1));
    const again = await queue.get(item.id);
    expect(again?.idempotencyKey).toBe(item.idempotencyKey);
    expect(again?.mutation).toEqual(item.mutation);
  });

  it('a double tap or a repeated save queues one create', async () => {
    const { queue } = memoryLayer();
    const first = await queue.enqueue(create('c1'), T0);
    const second = await queue.enqueue(create('c1'), at(1));
    expect(second).toEqual({ item: first.item, coalesced: true });
    expect(await queue.pendingCount()).toBe(1);
    // The same photo twice is queued once.
    await queue.enqueue(upload('c1', 'p1'), T0);
    await queue.enqueue(upload('c1', 'p1', 'another-id'), T0);
    expect(await queue.pendingCount()).toBe(2);
    // The same status twice in a row is one change.
    await queue.enqueue(taskStatus('t1', 'done'), T0);
    await queue.enqueue(taskStatus('t1', 'done'), T0);
    expect(await queue.pendingCount()).toBe(3);
  });

  it('survives a restart: a new queue on the same database has every item, crash mid-send resets to pending', async () => {
    const { db, queue } = memoryLayer();
    const a = await queue.enqueue(create('c1'), T0);
    const b = await queue.enqueue(taskStatus('t1', 'done'), at(1));
    await queue.markSending(a.item.id, at(2));

    // The app dies here (the server may or may not have stored the log).
    const restarted = createWriteQueue({ db, userId: USER_A, newId: idSequence('9') });
    expect(await restarted.recoverInterrupted()).toBe(1);
    const items = await restarted.list();
    expect(items.map((item) => [item.id, item.state])).toEqual([
      [a.item.id, 'pending'],
      [b.item.id, 'pending'],
    ]);
    // Same key, same clientId: the resend is a replay on the server, not a second log.
    expect(items[0]?.idempotencyKey).toBe(a.item.idempotencyKey);
    // And later seq numbers keep counting up.
    const c = await restarted.enqueue(taskStatus('t2', 'done'), at(3));
    expect(c.item.seq).toBeGreaterThan(b.item.seq);
  });

  it('never merges a change into an item that was sent before (the server may have it already)', async () => {
    const { queue } = memoryLayer();
    const { item } = await queue.enqueue(create('c1', { text: 'first' }), T0);
    await queue.markSending(item.id, T0);
    await queue.recoverInterrupted();
    const result = await queue.enqueue(edit('c1', { text: 'second' }), at(1));
    expect(result.coalesced).toBe(false);
    expect((await queue.get(item.id))?.mutation).toMatchObject({ body: { text: 'first' } });
  });

  it('enqueueAll is atomic: a failure queues nothing', async () => {
    const { db, queue } = memoryLayer();
    const broken = { ...upload('c1', 'p1') } as QueuedMutation;
    Object.defineProperty(broken, 'kind', {
      get: () => {
        throw new Error('boom');
      },
    });
    await expect(queue.enqueueAll([create('c1'), broken], T0)).rejects.toThrow('boom');
    expect(await queue.pendingCount()).toBe(0);
    expect(Object.keys(db.dump().queue)).toEqual([]);
  });
});

describe('write queue: coalescing and versions', () => {
  it('an edit of a log not sent yet rewrites its create', async () => {
    const { queue } = memoryLayer();
    const { item } = await queue.enqueue(create('c1', { text: 'first' }), T0);
    const result = await queue.enqueue(edit('c1', { text: 'second', siteId: null }), at(1));
    expect(result.coalesced).toBe(true);
    expect(await queue.pendingCount()).toBe(1);
    expect((await queue.get(item.id))?.mutation).toMatchObject({
      kind: 'createWorkLog',
      body: { clientId: 'c1', text: 'second', siteId: null },
    });
  });

  it('a photo added before the create was sent is declared in the create', async () => {
    const { queue } = memoryLayer();
    const { item } = await queue.enqueue(create('c1', { attachmentClientIds: ['a1'] }), T0);
    await queue.enqueue(upload('c1', 'p2', 'a2'), at(1));
    expect((await queue.get(item.id))?.mutation).toMatchObject({
      body: { attachmentClientIds: ['a1', 'a2'] },
    });
  });

  it('consecutive unsent edits merge (later fields win, first expectedVersion kept)', async () => {
    const { queue } = memoryLayer();
    await queue.enqueue(edit('c1', { text: 'a', expectedVersion: 3 }), T0);
    await queue.enqueue(edit('c1', { text: 'b', siteId: 's1', expectedVersion: 4 }), at(1));
    const items = await queue.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.mutation).toMatchObject({
      body: { text: 'b', siteId: 's1', expectedVersion: 3 },
    });
  });

  it('rebaseVersion gives the next unsent items the version the server returned', async () => {
    const { queue } = memoryLayer();
    const first = await queue.enqueue(edit('c1', { text: 'a', expectedVersion: 1 }), T0);
    await queue.markSending(first.item.id, T0);
    await queue.enqueue(edit('c1', { text: 'b', expectedVersion: 1 }), at(1));
    await queue.enqueue(
      { kind: 'changeWorkLogStatus', workLogClientId: 'c1', body: { status: 'submitted' } },
      at(2),
    );
    await queue.markDone(first.item.id);
    await queue.rebaseVersion('workLog:c1', 2);
    const bodies = (await queue.list()).map(
      (item) => (item.mutation as { body: { expectedVersion?: number } }).body.expectedVersion,
    );
    expect(bodies).toEqual([2, 2]);
  });

  it('records keys: workLog:<clientId> and task:<id>', () => {
    expect(recordKeyOf(create('c9'))).toBe('workLog:c9');
    expect(recordKeyOf(upload('c9', 'p'))).toBe('workLog:c9');
    expect(recordKeyOf(taskStatus('t9', 'done'))).toBe('task:t9');
  });
});

describe('write queue: what the worker can do with an item', () => {
  it('discarding a create removes its record and its local photos', async () => {
    const layer = memoryLayer();
    layer.files.seed(photo('p1').uri, 1000);
    const saved = await layer.photos.save(photo('p1'));
    expect(saved.ok).toBe(true);
    const { item } = await layer.queue.enqueue(create('c1'), T0);
    await layer.queue.enqueue(
      {
        kind: 'uploadAttachment',
        workLogClientId: 'c1',
        workLogId: null,
        attachmentClientId: 'att-p1',
        photo: saved.ok ? saved.photo : photo('p1'),
        checkpoint: { attachmentId: null, stored: false },
      },
      T0,
    );
    const other = await layer.queue.enqueue(taskStatus('t1', 'done'), T0);
    await layer.queue.discard(item.id);
    expect((await layer.queue.list()).map((left) => left.id)).toEqual([other.item.id]);
    expect(layer.files.files.size).toBe(0);
  });

  it('does not discard an item that is on its way to the server', async () => {
    const { queue } = memoryLayer();
    const { item } = await queue.enqueue(create('c1', { attachmentClientIds: ['a1'] }), T0);
    const upload1 = await queue.enqueue(upload('c1', 'p1', 'a1'), T0);
    await queue.markSending(item.id, T0);
    await queue.discard(item.id);
    expect((await queue.list()).map((left) => left.id)).toEqual([item.id, upload1.item.id]);
  });

  it('resubmits a refused create as a new log with fresh ids and the same photos', async () => {
    const { queue } = memoryLayer();
    const { item } = await queue.enqueue(create('c1', { attachmentClientIds: ['a1'] }), T0);
    await queue.enqueue(upload('c1', 'p1', 'a1'), T0);
    await queue.markSending(item.id, T0);
    await queue.markFailed(
      item.id,
      { code: 'occurred_at_out_of_range', message: 'old', status: 422 },
      true,
      null,
      T0,
    );

    const created = await queue.resubmitAsNew(item.id, at(5));
    const items = await queue.list();
    expect(items.map((left) => left.recordKey)).toEqual([created.recordKey, created.recordKey]);
    const body = (
      created.mutation as {
        body: { clientId: string; attachmentClientIds: string[]; text: string };
      }
    ).body;
    expect(body.clientId).not.toBe('c1');
    expect(body.text).toBe('New offline log');
    const photoItem = items[1]!.mutation as {
      attachmentClientId: string;
      photo: { localId: string };
    };
    expect(body.attachmentClientIds).toEqual([photoItem.attachmentClientId]);
    expect(photoItem.attachmentClientId).not.toBe('a1');
    expect(photoItem.photo.localId).toBe('p1');
    expect(created.idempotencyKey).not.toBe(item.idempotencyKey);
  });

  it('resubmits a refused edit as a new log with the cached content plus the edit', async () => {
    const layer = memoryLayer();
    await layer.store.upsert('workLogs', [
      workLog({ clientId: 'c1', text: 'server text', status: 'approved' }),
    ]);
    const { item } = await layer.queue.enqueue(
      edit('c1', { text: 'my text', expectedVersion: 1 }),
      T0,
    );
    await layer.queue.markFailed(
      item.id,
      { code: 'already_reviewed', message: 'x', status: 409 },
      true,
      null,
      T0,
    );
    const created = await layer.queue.resubmitAsNew(item.id, at(1));
    expect(created.mutation).toMatchObject({
      kind: 'createWorkLog',
      body: { text: 'my text', status: 'submitted', attachmentClientIds: [] },
    });
    expect(await layer.queue.get(item.id)).toBeNull();
  });

  it('copies the content as text, and clear() empties the queue and the photos', async () => {
    const layer = memoryLayer();
    const { item } = await layer.queue.enqueue(
      create('c1', { text: 'Leak at valve 3', customFields: { pressure: 4 } }),
      T0,
    );
    expect(await layer.queue.copyText(item.id)).toBe(
      `${T0.toISOString()}\nLeak at valve 3\npressure: 4`,
    );
    layer.files.seed('file:///documents/offline-photos/' + USER_A + '/x.jpg', 10);
    await layer.queue.clear();
    expect(await layer.queue.pendingCount()).toBe(0);
    expect(layer.files.files.size).toBe(0);
  });

  it('counts by state and notifies subscribers', async () => {
    const { queue } = memoryLayer();
    const calls: number[] = [];
    const stop = queue.subscribe(() => calls.push(1));
    const { item } = await queue.enqueue(taskStatus('t1', 'done'), T0);
    await queue.markSending(item.id, T0);
    expect(await queue.counts()).toEqual({
      pending: 0,
      sending: 1,
      failed_retryable: 0,
      failed_permanent: 0,
      done: 0,
    });
    stop();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
