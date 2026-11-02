import type { SmartCaptureContext } from '@ops/shared';

import { createOfflineRepositories } from '../data/repositories';
import { createSyncEngine } from './engine';
import {
  ceilingRetry,
  FakeApi,
  FakeNetwork,
  httpFailure,
  ManualScheduler,
  NETWORK_DOWN,
  type RecordedCall,
} from './engineTestKit';
import { memoryLayer, ORG, photo, T0, USER_A, USER_B } from './storeTestKit';
import type { LocalAudio } from './types';

// Smart capture on the phone (Phase 7, ADR-0010): the repository keeps the capture and queues
// it, the engine runs its steps (create, PUT, process) with a checkpoint and the usual retry
// rules, the result is kept for review, and confirming is an ordinary queued log create.

const CONTEXT: SmartCaptureContext = {
  taskId: null,
  siteId: null,
  logTypeId: null,
  capturedAt: '2026-10-27T09:30:00.000Z',
  languageHint: 'tr',
};

function setup(userId = USER_A) {
  const layer = memoryLayer(userId);
  const api = new FakeApi();
  const network = new FakeNetwork();
  const puts: string[] = [];
  let putResult: { ok: true } | { ok: false; status: number; message: string } = { ok: true };
  const engine = createSyncEngine(
    {
      userId,
      store: layer.store,
      queue: layer.queue,
      photos: layer.photos,
      audio: layer.audio,
      captures: layer.captures,
      api: api.asClient(),
      network,
      clock: () => T0,
      retry: ceilingRetry,
      onNeedsSignIn: () => undefined,
    },
    {
      put: (local) => async () => {
        puts.push(local.localId);
        return putResult;
      },
      putFile: (_uri, localId) => async () => {
        puts.push(localId);
        return putResult;
      },
      scheduler: new ManualScheduler(),
    },
  );
  const repositories = createOfflineRepositories({
    user: { id: userId, organizationId: ORG },
    store: layer.store,
    queue: layer.queue,
    photos: layer.photos,
    audio: layer.audio,
    captures: layer.captures,
    client: {} as never,
    newId: layer.newId,
    clock: () => T0,
  });
  return {
    ...layer,
    api,
    network,
    engine,
    repositories,
    puts,
    setPut: (result: typeof putResult) => (putResult = result),
  };
}

function recording(env: ReturnType<typeof setup>, localId = 'voice-1'): LocalAudio {
  const uri = `file:///cache/recordings/${localId}.m4a`;
  env.audioFiles.seed(uri, 40_000);
  return {
    localId,
    uri,
    fileName: 'voice-note.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 40_000,
    durationMs: 6000,
  };
}

const endpoints = (calls: RecordedCall[]) => calls.map((call) => call.endpoint);

describe('smart capture: queue and sync engine', () => {
  it('keeps a voice note recorded offline and processes it on reconnect', async () => {
    const env = setup();
    env.network.set(false);
    const started = await env.repositories.captures.start(
      { kind: 'voice', audio: recording(env) },
      CONTEXT,
    );
    expect(started.ok).toBe(true);
    const clientId = started.ok ? started.data.captureClientId : '';

    // Offline: nothing is sent; the capture is listed as waiting, its file is in the user's folder.
    expect((await env.engine.syncNow('manual')).stoppedBecause).toBe('offline');
    expect(env.api.calls).toEqual([]);
    const waiting = await env.captures.get(clientId);
    expect(waiting).toMatchObject({ capture: null, input: { kind: 'voice' } });
    const savedAudio = waiting?.input.kind === 'voice' ? waiting.input.audio : null;
    expect(savedAudio?.uri).toContain(`/${USER_A}/`);
    expect(await env.queue.referencedAudioIds()).toEqual(['voice-1']);

    env.network.set(true);
    const run = await env.engine.syncNow('reconnect');
    expect(run.sent).toBe(1);
    expect(endpoints(env.api.calls)).toEqual([
      'smartCapture.create',
      'smartCapture.process',
      'sync.pull',
    ]);
    expect(env.api.calls[0]?.body).toMatchObject({
      kind: 'voice',
      clientId,
      mimeType: 'audio/mp4',
      sizeBytes: 40_000,
      durationMs: 6000,
      context: CONTEXT,
    });
    expect(env.puts).toEqual(['voice-1']);
    // Kept for review; out of the queue; the voice note file is gone (the server has it).
    expect(await env.captures.get(clientId)).toMatchObject({ capture: { status: 'proposed' } });
    expect(await env.queue.list()).toEqual([]);
    expect(await env.audio.exists(savedAudio!)).toBe(false);
  });

  it('retries ai_unavailable from its checkpoint without creating or uploading again', async () => {
    const env = setup();
    await env.repositories.captures.start({ kind: 'voice', audio: recording(env) }, CONTEXT);
    let failProcess = true;
    env.api.interceptor = (call) =>
      call.endpoint === 'smartCapture.process' && failProcess
        ? httpFailure('ai_unavailable')
        : undefined;
    const first = await env.engine.syncNow('manual');
    expect(first.failedRetryable).toBe(1);
    const [item] = await env.queue.list();
    expect(item).toMatchObject({
      state: 'failed_retryable',
      lastError: { code: 'ai_unavailable' },
      mutation: { checkpoint: { uploaded: true, processed: false } },
    });
    expect(
      item?.mutation.kind === 'smartCapture' && item.mutation.checkpoint.captureId,
    ).toBeTruthy();

    failProcess = false;
    env.api.calls = [];
    await env.engine.syncNow('manual');
    expect(endpoints(env.api.calls)).toEqual(['smartCapture.process', 'sync.pull']);
    expect(env.puts).toEqual(['voice-1']);
    expect(await env.queue.list()).toEqual([]);
  });

  it.each([
    ['ai_disabled', 'failed_permanent'],
    ['ai_limit_reached', 'failed_permanent'],
    ['rate_limited', 'failed_retryable'],
    ['ai_unavailable', 'failed_retryable'],
    ['request_in_progress', 'failed_retryable'],
  ] as const)('judges %s on create as %s', async (code, state) => {
    const env = setup();
    await env.repositories.captures.start({ kind: 'text', text: 'Fixed the pump' }, CONTEXT);
    env.api.interceptor = (call) =>
      call.endpoint === 'smartCapture.create' ? httpFailure(code) : undefined;
    await env.engine.syncNow('manual');
    const [item] = await env.queue.list();
    expect(item).toMatchObject({ state, lastError: { code } });
  });

  it('retries a lost connection, and PUTs again after "upload first"', async () => {
    const env = setup();
    await env.repositories.captures.start({ kind: 'voice', audio: recording(env) }, CONTEXT);
    env.api.interceptor = (call) =>
      call.endpoint === 'smartCapture.create' ? NETWORK_DOWN : undefined;
    expect((await env.engine.syncNow('manual')).stoppedBecause).toBe('offline');

    let conflictOnce = true;
    env.api.interceptor = (call) => {
      if (call.endpoint === 'smartCapture.process' && conflictOnce) {
        conflictOnce = false;
        return httpFailure('conflict');
      }
      return undefined;
    };
    await env.engine.syncNow('manual');
    const [item] = await env.queue.list();
    expect(item).toMatchObject({
      state: 'failed_retryable',
      mutation: { checkpoint: { uploaded: false } },
    });
    await env.engine.syncNow('manual');
    expect(env.puts).toEqual(['voice-1', 'voice-1']);
    expect(endpoints(env.api.calls)).toContain('smartCapture.renewUpload');
    expect(await env.queue.list()).toEqual([]);
  });

  it('refuses for good when the voice note file is gone', async () => {
    const env = setup();
    const started = await env.repositories.captures.start(
      { kind: 'voice', audio: recording(env) },
      CONTEXT,
    );
    const local = await env.captures.get(started.ok ? started.data.captureClientId : '');
    if (local?.input.kind === 'voice') await env.audio.delete(local.input.audio.localId);
    await env.engine.syncNow('manual');
    const [item] = await env.queue.list();
    expect(item).toMatchObject({ state: 'failed_permanent', lastError: { code: 'audio_missing' } });
    expect(env.api.calls.filter((call) => call.endpoint.startsWith('smartCapture'))).toEqual([]);
  });

  it('processes a typed note with one call', async () => {
    const env = setup();
    const started = await env.repositories.captures.start({ kind: 'text', text: 'Fence' }, CONTEXT);
    await env.engine.syncNow('manual');
    expect(endpoints(env.api.calls)).toEqual(['smartCapture.create', 'sync.pull']);
    const local = await env.captures.get(started.ok ? started.data.captureClientId : '');
    expect(local?.capture?.status).toBe('proposed');
  });
});

describe('smart capture: confirm and discard', () => {
  async function processedPhoto(env: ReturnType<typeof setup>) {
    const snap = photo('snap-1', 2000);
    env.files.seed(snap.uri, snap.sizeBytes);
    const started = await env.repositories.captures.start(
      { kind: 'photo', photo: snap, note: 'Leak' },
      CONTEXT,
    );
    const clientId = started.ok ? started.data.captureClientId : '';
    await env.engine.syncNow('manual');
    const local = await env.captures.get(clientId);
    expect(local?.capture?.status).toBe('proposed');
    return {
      clientId,
      local: local!,
      kept: local!.input.kind === 'photo' ? local!.input.photo : snap,
    };
  }

  it('confirms as an ordinary queued ai_assisted create, with the Snap photo attached', async () => {
    const env = setup();
    const { clientId, local, kept } = await processedPhoto(env);
    const confirmed = await env.repositories.captures.confirm(
      clientId,
      {
        clientId: 'log-client-1',
        occurredAt: CONTEXT.capturedAt,
        text: 'Leak at the pump',
        source: 'manual',
      },
      [kept],
    );
    expect(confirmed.ok).toBe(true);
    const items = await env.queue.list();
    expect(items.map((item) => item.mutation.kind)).toEqual(['createWorkLog', 'uploadAttachment']);
    expect(items[0]?.mutation).toMatchObject({
      body: { source: 'ai_assisted', aiProposalId: local.capture!.id, text: 'Leak at the pump' },
    });
    expect(await env.captures.get(clientId)).toBeNull();
    // The photo now belongs to the log's upload.
    expect(await env.photos.exists(kept)).toBe(true);
    expect(await env.queue.referencedPhotoIds()).toEqual(['snap-1']);
  });

  it('confirms without the photo: the photo file is deleted', async () => {
    const env = setup();
    const { clientId, kept } = await processedPhoto(env);
    await env.repositories.captures.confirm(clientId, {
      clientId: 'log-client-2',
      occurredAt: CONTEXT.capturedAt,
      text: 'No photo',
    });
    expect(await env.photos.exists(kept)).toBe(false);
  });

  it('confirms a capture that was never processed as a manual log and drops its queue item', async () => {
    const env = setup();
    const started = await env.repositories.captures.start({ kind: 'text', text: 'Fence' }, CONTEXT);
    env.api.interceptor = () => httpFailure('ai_disabled');
    await env.engine.syncNow('manual');
    const clientId = started.ok ? started.data.captureClientId : '';
    await env.repositories.captures.confirm(clientId, {
      clientId: 'log-client-3',
      occurredAt: CONTEXT.capturedAt,
      text: 'Fence',
    });
    const items = await env.queue.list();
    // The server has the capture (created before it refused to process): it is discarded there.
    expect(items.map((item) => item.mutation.kind)).toEqual(['createWorkLog']);
    expect(items[0]?.mutation).toMatchObject({ body: { source: 'manual' } });
    expect(JSON.stringify(items[0]?.mutation)).not.toContain('aiProposalId');
  });

  it('discards a processed capture on the server, and a waiting one only on the phone', async () => {
    const env = setup();
    const { clientId, kept } = await processedPhoto(env);
    expect((await env.repositories.captures.discard(clientId)).ok).toBe(true);
    expect(await env.captures.get(clientId)).toBeNull();
    expect(await env.photos.exists(kept)).toBe(false);
    env.api.calls = [];
    await env.engine.syncNow('manual');
    expect(endpoints(env.api.calls)).toEqual(['smartCapture.discard', 'sync.pull']);

    env.network.set(false);
    const waiting = await env.repositories.captures.start(
      { kind: 'voice', audio: recording(env, 'voice-2') },
      CONTEXT,
    );
    const waitingId = waiting.ok ? waiting.data.captureClientId : '';
    await env.repositories.captures.discard(waitingId);
    expect(await env.queue.list()).toEqual([]);
    expect(await env.captures.list()).toEqual([]);
    expect(await env.queue.referencedAudioIds()).toEqual([]);
    expect([...env.audioFiles.files.keys()]).toEqual([]);
  });
});

describe('smart capture: offline voice notes and the form by hand', () => {
  it('while a voice note waits offline, the worker fills the form by hand: only that log is sent', async () => {
    const env = setup();
    env.network.set(false);
    const started = await env.repositories.captures.start(
      { kind: 'voice', audio: recording(env) },
      CONTEXT,
    );
    const clientId = started.ok ? started.data.captureClientId : '';
    const local = await env.captures.get(clientId);
    const savedAudio = local?.input.kind === 'voice' ? local.input.audio : null;
    expect(savedAudio).not.toBeNull();

    const confirmed = await env.repositories.captures.confirm(clientId, {
      clientId: 'log-by-hand-1',
      occurredAt: CONTEXT.capturedAt,
      text: 'Pump fixed, filled in by hand',
    });
    expect(confirmed.ok).toBe(true);
    // The capture never reached the server: no AI source, no capture reference, no voice file.
    const items = await env.queue.list();
    expect(items.map((item) => item.mutation.kind)).toEqual(['createWorkLog']);
    expect(items[0]?.mutation).toMatchObject({
      body: { source: 'manual', text: 'Pump fixed, filled in by hand' },
    });
    expect(JSON.stringify(items[0]?.mutation)).not.toContain('aiProposalId');
    expect(await env.captures.list()).toEqual([]);
    expect(await env.queue.referencedAudioIds()).toEqual([]);
    expect(await env.audio.exists(savedAudio!)).toBe(false);

    env.network.set(true);
    await env.engine.syncNow('reconnect');
    expect(endpoints(env.api.calls)).toEqual(['workLogs.create', 'sync.pull']);
    expect(env.api.calls[0]?.body).toMatchObject({
      clientId: 'log-by-hand-1',
      source: 'manual',
      text: 'Pump fixed, filled in by hand',
    });
    expect(env.puts).toEqual([]);
    expect(await env.queue.list()).toEqual([]);
  });

  it('several voice notes recorded offline are each processed on reconnect and kept for review', async () => {
    const env = setup();
    env.network.set(false);
    const ids: string[] = [];
    for (const localId of ['voice-1', 'voice-2']) {
      const started = await env.repositories.captures.start(
        { kind: 'voice', audio: recording(env, localId) },
        CONTEXT,
      );
      ids.push(started.ok ? started.data.captureClientId : '');
    }
    expect((await env.engine.syncNow('manual')).stoppedBecause).toBe('offline');
    expect(env.api.calls).toEqual([]);
    expect([...(await env.queue.referencedAudioIds())].sort()).toEqual(['voice-1', 'voice-2']);

    env.network.set(true);
    const run = await env.engine.syncNow('reconnect');
    expect(run.sent).toBe(2);
    expect(env.api.callsTo('smartCapture.create').map((call) => call.body)).toEqual([
      expect.objectContaining({ clientId: ids[0], kind: 'voice' }),
      expect.objectContaining({ clientId: ids[1], kind: 'voice' }),
    ]);
    expect(env.api.callsTo('smartCapture.process')).toHaveLength(2);
    expect([...env.puts].sort()).toEqual(['voice-1', 'voice-2']);
    for (const id of ids) {
      expect(await env.captures.get(id)).toMatchObject({ capture: { status: 'proposed' } });
    }
    expect(await env.queue.list()).toEqual([]);
    expect([...env.audioFiles.files.keys()]).toEqual([]);
  });

  it('a proposal confirmed while offline is queued as an ai_assisted create and sent on reconnect', async () => {
    const env = setup();
    const started = await env.repositories.captures.start(
      { kind: 'voice', audio: recording(env) },
      CONTEXT,
    );
    const clientId = started.ok ? started.data.captureClientId : '';
    await env.engine.syncNow('manual');
    const processed = await env.captures.get(clientId);
    expect(processed?.capture?.status).toBe('proposed');

    env.network.set(false);
    env.api.calls = [];
    const confirmed = await env.repositories.captures.confirm(clientId, {
      clientId: 'log-offline-1',
      occurredAt: CONTEXT.capturedAt,
      text: 'Checked the pump',
    });
    expect(confirmed.ok).toBe(true);
    const [item] = await env.queue.list();
    expect(item?.mutation).toMatchObject({
      kind: 'createWorkLog',
      body: { source: 'ai_assisted', aiProposalId: processed!.capture!.id },
    });
    expect((await env.engine.syncNow('manual')).stoppedBecause).toBe('offline');
    expect(env.api.calls).toEqual([]);

    env.network.set(true);
    await env.engine.syncNow('reconnect');
    expect(endpoints(env.api.calls)).toEqual(['workLogs.create', 'sync.pull']);
    expect(env.api.calls[0]?.body).toMatchObject({
      clientId: 'log-offline-1',
      source: 'ai_assisted',
      aiProposalId: processed!.capture!.id,
    });
    // The client never sends aiMetadata: the server writes it.
    expect(env.api.calls[0]?.body).not.toHaveProperty('aiMetadata');
    expect(await env.queue.list()).toEqual([]);
  });
});

describe('smart capture: one user never sees another user’s captures', () => {
  it('keeps captures in each user’s own database and folders', async () => {
    const a = setup(USER_A);
    const b = setup(USER_B);
    await a.repositories.captures.start({ kind: 'voice', audio: recording(a) }, CONTEXT);
    expect(await a.captures.list()).toHaveLength(1);
    expect(await b.captures.list()).toEqual([]);
    expect(await b.queue.list()).toEqual([]);
    await b.engine.syncNow('manual');
    expect(b.api.calls.filter((call) => call.endpoint.startsWith('smartCapture'))).toEqual([]);
    expect([...a.audioFiles.files.keys()].every((uri) => uri.includes(`/${USER_A}/`))).toBe(true);
  });
});
