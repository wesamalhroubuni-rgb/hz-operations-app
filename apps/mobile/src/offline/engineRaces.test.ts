import type { UploadPut } from '@ops/shared';

import { createMemoryDatabase } from './db';
import { createHarness, photoFixture, testUuid, workLogFixture } from './engineTestKit';
import type { QueuedMutation } from './types';
import { createWriteQueue } from './writeQueue';

// The engine against the REAL write queue (memory database): changes merged into, or discards
// of, items while the engine is busy with another record must never be lost or resurrected.

const NOW = new Date('2026-10-27T10:00:00.000Z');

function realQueue() {
  return createWriteQueue({ db: createMemoryDatabase(), userId: 'user-1', newId: testUuid });
}

function createLog(clientId: string, text = 'First text'): QueuedMutation {
  return {
    kind: 'createWorkLog',
    body: { clientId, text, occurredAt: '2026-10-27T08:00:00.000Z', attachmentClientIds: [] },
  };
}

/** A PUT that waits until the test opens it, and runs `during` while it waits. */
function slowPut(during: () => Promise<void>): { put: () => UploadPut; open: () => void } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    put: () => async () => {
      await during();
      await gate;
      return { ok: true };
    },
    open: () => open(),
  };
}

/** A photo of a log already on the server: the first record of the queue. */
function uploadToKnownLog(): QueuedMutation {
  const log = workLogFixture();
  return {
    kind: 'uploadAttachment',
    workLogClientId: log.clientId,
    workLogId: log.id,
    attachmentClientId: testUuid(),
    photo: photoFixture('busy'),
    checkpoint: { attachmentId: null, stored: false },
  };
}

describe('sync engine with the real queue: changes during another record’s upload', () => {
  it('sends an edit merged into an unsent create while another photo was uploading', async () => {
    const queue = realQueue();
    const clientId = testUuid();
    const slow = slowPut(async () => {
      // The worker edits the not-yet-sent log while the other photo uploads.
      await queue.enqueue(
        { kind: 'updateWorkLog', workLogClientId: clientId, body: { text: 'Edited text' } },
        NOW,
      );
      slow.open();
    });
    const h = createHarness({ queue, put: slow.put });
    h.photos.files.add('busy');
    await queue.enqueue(uploadToKnownLog(), NOW);
    await queue.enqueue(createLog(clientId), NOW);

    const result = await h.engine.syncNow('manual');

    expect(result.sent).toBe(2);
    expect(h.api.callsTo('workLogs.create')[0]?.body).toMatchObject({ text: 'Edited text' });
    expect(h.api.logsByClientId.get(clientId)?.text).toBe('Edited text');
    expect(await queue.list()).toEqual([]);
  });

  it('never sends an item discarded while another photo was uploading', async () => {
    const queue = realQueue();
    const clientId = testUuid();
    let discardId = '';
    const slow = slowPut(async () => {
      await queue.discard(discardId);
      slow.open();
    });
    const h = createHarness({ queue, put: slow.put });
    h.photos.files.add('busy');
    await queue.enqueue(uploadToKnownLog(), NOW);
    discardId = (await queue.enqueue(createLog(clientId), NOW)).item.id;

    const result = await h.engine.syncNow('manual');

    expect(result.sent).toBe(1);
    expect(h.api.callsTo('workLogs.create')).toHaveLength(0);
    expect(await queue.list()).toEqual([]);
  });

  it('keeps a change queued after the item was claimed as a separate item', async () => {
    const queue = realQueue();
    const clientId = testUuid();
    const h = createHarness({ queue });
    await queue.enqueue(createLog(clientId), NOW);
    h.api.interceptor = async (call) => {
      if (call.endpoint === 'workLogs.create') {
        // The create is in flight (claimed): this edit must become its own item.
        await queue.enqueue(
          { kind: 'updateWorkLog', workLogClientId: clientId, body: { text: 'Later edit' } },
          NOW,
        );
      }
      return undefined;
    };

    await h.engine.syncNow('manual');
    await h.engine.syncNow('manual');

    expect(h.api.callsTo('workLogs.create')[0]?.body).toMatchObject({ text: 'First text' });
    expect(h.api.callsTo('workLogs.update')[0]?.body).toMatchObject({ text: 'Later edit' });
    expect(h.api.logsByClientId.get(clientId)?.text).toBe('Later edit');
    expect(await queue.list()).toEqual([]);
  });
});

describe('sync engine with the real queue: the clientId to server id link', () => {
  it('sends a later edit after the read cache was cleared (keep for later)', async () => {
    const queue = realQueue();
    const clientId = testUuid();
    const h = createHarness({ queue });
    await queue.enqueue(createLog(clientId), NOW);
    let failEdit = true;
    h.api.interceptor = async (call) => {
      if (call.endpoint === 'workLogs.create') {
        // Edited while the create is in flight: a separate item that needs the server id.
        await queue.enqueue(
          { kind: 'updateWorkLog', workLogClientId: clientId, body: { text: 'Edit' } },
          NOW,
        );
      }
      if (call.endpoint === 'workLogs.update' && failEdit) {
        failEdit = false;
        return { kind: 'network', message: 'down' };
      }
      return undefined;
    };

    await h.engine.syncNow('manual');
    // "Keep for later" sign-out: the read cache goes, the queue stays.
    await h.store.clearCache();
    expect(await h.store.getWorkLogByClientId(clientId)).toBeNull();
    await h.engine.syncNow('manual');

    const server = h.api.logsByClientId.get(clientId);
    expect(h.api.callsTo('workLogs.update').at(-1)?.id).toBe(server?.id);
    expect(server?.text).toBe('Edit');
    expect(await queue.list()).toEqual([]);
    expect(await queue.serverIdOf(clientId)).toBeNull();
  });

  it('treats an unknown log as retryable (never final) and pulls', async () => {
    const queue = realQueue();
    const h = createHarness({ queue });
    const item = (
      await queue.enqueue(
        { kind: 'updateWorkLog', workLogClientId: testUuid(), body: { text: 'Edit' } },
        NOW,
      )
    ).item;
    // Pulled recently: a timer run would normally not pull again.
    await h.engine.syncNow('manual');
    h.clock.advance(1000);
    await queue.retry(item.id, h.clock.read());
    await h.engine.syncNow('timer');

    const stored = await queue.get(item.id);
    expect(stored?.state).toBe('failed_retryable');
    expect(stored?.lastError?.code).toBe('not_found');
    expect(h.api.callsTo('sync.pull')).toHaveLength(2);
  });
});

describe('sync engine with the real queue: photo files', () => {
  it('finishes a photo whose file is gone when the server already has it ready', async () => {
    const queue = realQueue();
    const h = createHarness({ queue });
    const attachmentClientId = testUuid();
    h.api.attachmentsByClientId.set(attachmentClientId, { id: 'att-1', status: 'ready' });
    const log = workLogFixture();
    // The app died after the upload completed and the file was deleted, before markDone.
    await queue.enqueue(
      {
        kind: 'uploadAttachment',
        workLogClientId: log.clientId,
        workLogId: log.id,
        attachmentClientId,
        photo: photoFixture('gone'),
        checkpoint: { attachmentId: 'att-1', stored: true },
      },
      NOW,
    );

    const result = await h.engine.syncNow('manual');

    expect(result).toMatchObject({ sent: 1, failedPermanent: 0 });
    expect(h.puts).toEqual([]);
    expect(await queue.list()).toEqual([]);
  });

  it('deletes the photo file only after the item left the queue', async () => {
    const queue = realQueue();
    const h = createHarness({ queue });
    h.photos.files.add('p1');
    const log = workLogFixture();
    await queue.enqueue(
      {
        kind: 'uploadAttachment',
        workLogClientId: log.clientId,
        workLogId: log.id,
        attachmentClientId: testUuid(),
        photo: photoFixture('p1'),
        checkpoint: { attachmentId: null, stored: false },
      },
      NOW,
    );
    const order: string[] = [];
    const markDone = queue.markDone.bind(queue);
    queue.markDone = async (id) => {
      order.push('markDone');
      await markDone(id);
    };
    const remove = h.photos.delete.bind(h.photos);
    h.photos.delete = async (localId) => {
      order.push('deleteFile');
      await remove(localId);
    };

    await h.engine.syncNow('manual');

    expect(order).toEqual(['markDone', 'deleteFile']);
  });
});
