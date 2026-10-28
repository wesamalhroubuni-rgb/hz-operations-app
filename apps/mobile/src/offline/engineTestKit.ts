// Fakes for the sync engine tests (not used by the app). They follow the contracts of
// `types.ts` closely enough to exercise the engine: the queue's per-record ordering and
// blocking, the store's pull pruning, an API that remembers clientIds and idempotency keys like
// the server does.

import type {
  ApiCallOptions,
  ApiClient,
  ApiErrorCode,
  ApiFailure,
  ApiResult,
  SyncPullResponse,
  Task,
  UploadPut,
  WorkLog,
} from '@ops/shared';
import { API_ERROR_STATUS } from '@ops/shared';

import type { LocalPhoto } from '../storage/localPhoto';
import { createSyncEngine, type Scheduler, type SyncEngineOptions } from './engine';
import type {
  CachedResourceName,
  CachedResources,
  EnqueueResult,
  LocalPhotoStore,
  LocalStore,
  NetworkMonitor,
  QueuedMutation,
  QueueItem,
  QueueItemError,
  QueueItemState,
  RetryPolicy,
  SyncMeta,
  WriteQueue,
} from './types';

export function recordKeyOf(mutation: QueuedMutation): string {
  switch (mutation.kind) {
    case 'createWorkLog':
      return `workLog:${mutation.body.clientId}`;
    case 'changeTaskStatus':
      return `task:${mutation.taskId}`;
    default:
      return `workLog:${mutation.workLogClientId}`;
  }
}

let uuidCounter = 0;
export function testUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

export class FakeQueue implements WriteQueue {
  readonly userId = 'user-1';
  items: QueueItem[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  async enqueue(mutation: QueuedMutation, now: Date): Promise<EnqueueResult> {
    this.seq += 1;
    const item: QueueItem = {
      id: testUuid(),
      seq: this.seq,
      recordKey: recordKeyOf(mutation),
      mutation,
      state: 'pending',
      idempotencyKey: testUuid(),
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.items.push(item);
    this.changed();
    return { item, coalesced: false };
  }

  /** Puts an item in as it was found on disk (crash recovery tests). */
  seed(item: Partial<QueueItem> & { mutation: QueuedMutation }): QueueItem {
    this.seq += 1;
    const full: QueueItem = {
      id: testUuid(),
      seq: this.seq,
      recordKey: recordKeyOf(item.mutation),
      state: 'pending',
      idempotencyKey: testUuid(),
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      createdAt: '2026-10-27T08:00:00.000Z',
      updatedAt: '2026-10-27T08:00:00.000Z',
      ...item,
    };
    this.items.push(full);
    return full;
  }

  async list(): Promise<QueueItem[]> {
    return this.items.filter((item) => item.state !== 'done').sort((a, b) => a.seq - b.seq);
  }

  async nextBatch(now: Date): Promise<QueueItem[]> {
    const firstPerRecord = new Map<string, QueueItem>();
    for (const item of await this.list()) {
      if (!firstPerRecord.has(item.recordKey)) firstPerRecord.set(item.recordKey, item);
    }
    return [...firstPerRecord.values()].filter(
      (item) =>
        (item.state === 'pending' || item.state === 'failed_retryable') &&
        (item.nextAttemptAt === null || Date.parse(item.nextAttemptAt) <= now.getTime()),
    );
  }

  async get(id: string): Promise<QueueItem | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }

  async counts(): Promise<Record<QueueItemState, number>> {
    const counts: Record<QueueItemState, number> = {
      pending: 0,
      sending: 0,
      failed_retryable: 0,
      failed_permanent: 0,
      done: 0,
    };
    for (const item of this.items) counts[item.state] += 1;
    return counts;
  }

  private update(id: string, patch: Partial<QueueItem>): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`No queue item ${id}`);
    Object.assign(item, patch);
    this.changed();
  }

  links = new Map<string, string>();

  async markSending(id: string, now: Date): Promise<QueueItem | null> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || (item.state !== 'pending' && item.state !== 'failed_retryable')) return null;
    this.update(id, { state: 'sending', updatedAt: now.toISOString() });
    return { ...item, mutation: structuredClone(item.mutation) };
  }

  async markDone(id: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item?.state !== 'sending') return;
    this.items = this.items.filter((candidate) => candidate.id !== id);
    if (!this.items.some((candidate) => candidate.recordKey === item.recordKey)) {
      this.links.delete(item.recordKey.replace(/^workLog:/, ''));
    }
    this.changed();
  }

  async linkServerId(workLogClientId: string, serverId: string): Promise<void> {
    this.links.set(workLogClientId, serverId);
  }

  async serverIdOf(workLogClientId: string): Promise<string | null> {
    return this.links.get(workLogClientId) ?? null;
  }

  async markFailed(
    id: string,
    error: QueueItemError,
    permanent: boolean,
    nextAttemptAt: Date | null,
    now: Date,
  ): Promise<void> {
    const item = this.items.find((candidate) => candidate.id === id);
    this.update(id, {
      state: permanent ? 'failed_permanent' : 'failed_retryable',
      lastError: error,
      attempts: (item?.attempts ?? 0) + 1,
      nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
      updatedAt: now.toISOString(),
    });
  }

  async saveCheckpoint(
    id: string,
    checkpoint: { attachmentId: string | null; stored: boolean },
  ): Promise<void> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item?.mutation.kind === 'uploadAttachment') {
      item.mutation = { ...item.mutation, checkpoint };
    }
  }

  async rebaseVersion(recordKey: string, version: number): Promise<void> {
    for (const item of this.items) {
      if (item.recordKey !== recordKey || item.state === 'sending') continue;
      const mutation = item.mutation;
      if (
        (mutation.kind === 'updateWorkLog' ||
          mutation.kind === 'changeWorkLogStatus' ||
          mutation.kind === 'changeTaskStatus') &&
        mutation.body.expectedVersion !== undefined
      ) {
        item.mutation = {
          ...mutation,
          body: { ...mutation.body, expectedVersion: version },
        } as QueuedMutation;
      }
    }
  }

  async recoverInterrupted(): Promise<number> {
    let count = 0;
    for (const item of this.items) {
      if (item.state === 'sending') {
        item.state = 'pending';
        count += 1;
      }
    }
    return count;
  }

  async retry(id: string, now: Date): Promise<void> {
    this.update(id, {
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      updatedAt: now.toISOString(),
    });
  }

  async discard(id: string): Promise<void> {
    this.items = this.items.filter((item) => item.id !== id);
    this.changed();
  }

  async resubmitAsNew(id: string, now: Date): Promise<QueueItem> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item?.mutation.kind !== 'createWorkLog') throw new Error('Not a create');
    this.items = this.items.filter((candidate) => candidate.id !== id);
    return (
      await this.enqueue(
        { kind: 'createWorkLog', body: { ...item.mutation.body, clientId: testUuid() } },
        now,
      )
    ).item;
  }

  async copyText(id: string): Promise<string> {
    return JSON.stringify((await this.get(id))?.mutation ?? null);
  }

  async pendingCount(): Promise<number> {
    return (await this.list()).length;
  }

  async clear(): Promise<void> {
    this.items = [];
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

type Tables = { [Name in CachedResourceName]: Map<string, CachedResources[Name]> };

export class FakeStore implements LocalStore {
  readonly userId = 'user-1';
  tables: Tables = {
    tasks: new Map(),
    logTypes: new Map(),
    sites: new Map(),
    teams: new Map(),
    workLogs: new Map(),
    notifications: new Map(),
  };
  meta: SyncMeta = {
    cursor: null,
    lastRefreshedAt: null,
    lastServerTime: null,
    organization: null,
  };
  applied: SyncPullResponse[] = [];
  /** Simulates a store that loses a row on apply (to test the repair pull). */
  dropOnApply: string | null = null;

  async list<Name extends CachedResourceName>(resource: Name): Promise<CachedResources[Name][]> {
    return [...(this.tables[resource] as Map<string, CachedResources[Name]>).values()];
  }
  async get<Name extends CachedResourceName>(
    resource: Name,
    id: string,
  ): Promise<CachedResources[Name] | null> {
    return (this.tables[resource] as Map<string, CachedResources[Name]>).get(id) ?? null;
  }
  async getWorkLogByClientId(clientId: string): Promise<WorkLog | null> {
    return [...this.tables.workLogs.values()].find((log) => log.clientId === clientId) ?? null;
  }
  async upsert<Name extends CachedResourceName>(
    resource: Name,
    records: readonly CachedResources[Name][],
  ): Promise<void> {
    const table = this.tables[resource] as Map<string, CachedResources[Name]>;
    for (const record of records) table.set(record.id, record);
  }
  async retainOnly(resource: CachedResourceName, ids: readonly string[]): Promise<void> {
    const keep = new Set(ids);
    for (const id of [...this.tables[resource].keys()]) {
      if (!keep.has(id)) this.tables[resource].delete(id);
    }
  }
  async replaceAll<Name extends CachedResourceName>(
    resource: Name,
    records: readonly CachedResources[Name][],
  ): Promise<void> {
    this.tables[resource].clear();
    await this.upsert(resource, records);
  }
  async getSyncMeta(): Promise<SyncMeta> {
    return { ...this.meta };
  }
  async setSyncMeta(meta: Partial<SyncMeta>): Promise<void> {
    this.meta = { ...this.meta, ...meta };
  }
  async applyPull(pull: SyncPullResponse, refreshedAt: Date): Promise<void> {
    this.applied.push(pull);
    const resources = ['tasks', 'logTypes', 'sites', 'teams', 'workLogs', 'notifications'] as const;
    for (const resource of resources) {
      const part = pull[resource] as { upserts: { id: string }[]; ids: string[] };
      if (pull.full) {
        await this.replaceAll(resource, part.upserts as never[]);
      } else {
        await this.upsert(resource, part.upserts as never[]);
        await this.retainOnly(resource, part.ids);
      }
      if (this.dropOnApply) this.tables[resource].delete(this.dropOnApply);
    }
    this.dropOnApply = null;
    this.meta = {
      cursor: pull.cursor,
      lastRefreshedAt: refreshedAt.toISOString(),
      lastServerTime: pull.serverTime,
      organization: pull.organization,
    };
  }
  async clearCache(): Promise<void> {
    for (const table of Object.values(this.tables)) table.clear();
  }
  subscribe(): () => void {
    return () => undefined;
  }
  async close(): Promise<void> {}
}

export class FakePhotos implements LocalPhotoStore {
  readonly userId = 'user-1';
  files = new Set<string>();
  deleted: string[] = [];
  async save(photo: LocalPhoto) {
    this.files.add(photo.localId);
    return { ok: true as const, photo };
  }
  async exists(photo: LocalPhoto): Promise<boolean> {
    return this.files.has(photo.localId);
  }
  async delete(localId: string): Promise<void> {
    this.files.delete(localId);
    this.deleted.push(localId);
  }
  async deleteAllExcept(): Promise<number> {
    return 0;
  }
  async totalBytes(): Promise<number> {
    return 0;
  }
  async usage() {
    return { usedBytes: 0, limitBytes: 1, level: 'ok' as const };
  }
  async canAdd(): Promise<boolean> {
    return true;
  }
  async clear(): Promise<void> {
    this.files.clear();
  }
}

export class FakeNetwork implements NetworkMonitor {
  online = true;
  private listeners = new Set<(online: boolean) => void>();
  isOnline(): boolean {
    return this.online;
  }
  set(online: boolean): void {
    this.online = online;
    for (const listener of this.listeners) listener(online);
  }
  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export interface RecordedCall {
  endpoint: string;
  id: string | null;
  body: unknown;
  headers: Record<string, string>;
}

export function httpFailure(code: ApiErrorCode, message = code): ApiFailure {
  const status = API_ERROR_STATUS[code];
  return {
    kind: 'http',
    status,
    message,
    error: {
      statusCode: status,
      code,
      message,
      correlationId: null,
      timestamp: '2026-10-27T10:00:00.000Z',
    },
  };
}

export const NETWORK_DOWN: ApiFailure = { kind: 'network', message: 'Network request failed' };
export const TIMED_OUT: ApiFailure = { kind: 'timeout', message: 'No response within 10000 ms' };

/** A response override: return a failure, or undefined to let the fake server answer. */
export type Interceptor = (
  call: RecordedCall,
) => ApiFailure | undefined | Promise<ApiFailure | undefined>;

export function workLogFixture(overrides: Partial<WorkLog> = {}): WorkLog {
  return {
    id: testUuid(),
    clientId: testUuid(),
    version: 1,
    status: 'submitted',
    text: 'Fixed the pump',
    customFields: {},
    occurredAt: '2026-10-27T08:00:00.000Z',
    ...overrides,
  } as unknown as WorkLog;
}

export function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: testUuid(),
    title: 'Check the pump',
    status: 'todo',
    version: 1,
    ...overrides,
  } as unknown as Task;
}

/** A fake API server that keeps logs by clientId and attachments by clientId, like the real one. */
export class FakeApi {
  calls: RecordedCall[] = [];
  logsByClientId = new Map<string, WorkLog>();
  logsById = new Map<string, WorkLog>();
  tasks = new Map<string, Task>();
  attachmentsByClientId = new Map<string, { id: string; status: 'pending' | 'ready' }>();
  pullResponses: (SyncPullResponse | ApiFailure)[] = [];
  interceptor: Interceptor | null = null;
  /** In-flight calls now, and the most seen at once (concurrency checks). */
  inFlight = 0;
  maxInFlight = 0;
  /** Makes every call wait for this promise first (slow network). */
  gate: Promise<void> | null = null;

  private async handle<Data>(
    endpoint: string,
    id: string | null,
    body: unknown,
    options: ApiCallOptions | undefined,
    answer: () => ApiResult<Data>,
  ): Promise<ApiResult<Data>> {
    const call: RecordedCall = { endpoint, id, body, headers: { ...(options?.headers ?? {}) } };
    this.calls.push(call);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate) await this.gate;
      const failure = await this.interceptor?.(call);
      if (failure) return { ok: false, failure };
      return answer();
    } finally {
      this.inFlight -= 1;
    }
  }

  callsTo(endpoint: string): RecordedCall[] {
    return this.calls.filter((call) => call.endpoint === endpoint);
  }

  readonly client = {
    workLogs: {
      create: (body: { clientId: string } & Record<string, unknown>, options?: ApiCallOptions) =>
        this.handle('workLogs.create', null, body, options, () => {
          const existing = this.logsByClientId.get(body.clientId);
          if (existing) return { ok: true, status: 200, data: existing };
          const log = workLogFixture({ ...(body as Partial<WorkLog>), version: 1 });
          this.logsByClientId.set(body.clientId, log);
          this.logsById.set(log.id, log);
          return { ok: true, status: 201, data: log };
        }),
      update: (id: string, body: Record<string, unknown>, options?: ApiCallOptions) =>
        this.handle('workLogs.update', id, body, options, () => this.changeLog(id, body)),
      changeStatus: (id: string, body: Record<string, unknown>, options?: ApiCallOptions) =>
        this.handle('workLogs.changeStatus', id, body, options, () => this.changeLog(id, body)),
    },
    tasks: {
      changeStatus: (id: string, body: Record<string, unknown>, options?: ApiCallOptions) =>
        this.handle('tasks.changeStatus', id, body, options, (): ApiResult<Task> => {
          const task = this.tasks.get(id);
          if (!task) return { ok: false, failure: httpFailure('not_found') };
          const next = { ...task, status: body.status, version: task.version + 1 } as Task;
          this.tasks.set(id, next);
          return { ok: true, status: 200, data: next };
        }),
    },
    attachments: {
      startUpload: (
        workLogId: string,
        body: { clientId?: string; fileName: string },
        options?: ApiCallOptions,
      ) =>
        this.handle('attachments.startUpload', workLogId, body, options, () => {
          const key = body.clientId ?? testUuid();
          let attachment = this.attachmentsByClientId.get(key);
          if (!attachment) {
            attachment = { id: testUuid(), status: 'pending' };
            this.attachmentsByClientId.set(key, attachment);
          }
          return {
            ok: true,
            status: 201,
            data: {
              attachment: { ...attachment, workLogId },
              upload:
                attachment.status === 'ready'
                  ? null
                  : {
                      url: 'https://storage.invalid/upload',
                      method: 'PUT',
                      headers: {},
                      expiresAt: '2099-01-01T00:00:00.000Z',
                    },
            },
          } as never;
        }),
      renewUpload: (id: string, options?: ApiCallOptions) =>
        this.handle('attachments.renewUpload', id, null, options, () => ({
          ok: true,
          status: 200,
          data: {
            attachment: { id, status: 'pending' },
            upload: {
              url: 'https://storage.invalid/upload',
              method: 'PUT',
              headers: {},
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          } as never,
        })),
      complete: (id: string, options?: ApiCallOptions) =>
        this.handle('attachments.complete', id, null, options, () => {
          for (const attachment of this.attachmentsByClientId.values()) {
            if (attachment.id === id) attachment.status = 'ready';
          }
          return { ok: true, status: 200, data: { id, status: 'ready' } as never };
        }),
      get: (id: string) =>
        this.handle('attachments.get', id, null, undefined, () => ({
          ok: true,
          status: 200,
          data: { id, status: 'ready' } as never,
        })),
    },
    sync: {
      pull: (query: { cursor?: string } = {}) =>
        this.handle('sync.pull', null, query, undefined, (): ApiResult<SyncPullResponse> => {
          const next = this.pullResponses.shift() ?? pullFixture();
          if ('kind' in next) return { ok: false, failure: next };
          return { ok: true, status: 200, data: next };
        }),
    },
  };

  private changeLog(id: string, body: Record<string, unknown>): ApiResult<WorkLog> {
    const log = this.logsById.get(id);
    if (!log) return { ok: false, failure: httpFailure('not_found') };
    const { expectedVersion, ...changes } = body;
    if (expectedVersion !== undefined && expectedVersion !== log.version) {
      return { ok: false, failure: httpFailure('version_conflict') };
    }
    const next = { ...log, ...changes, version: log.version + 1 } as WorkLog;
    this.logsById.set(id, next);
    this.logsByClientId.set(next.clientId, next);
    return { ok: true, status: 200, data: next };
  }

  asClient(): ApiClient {
    return this.client as unknown as ApiClient;
  }
}

export function pullFixture(overrides: Partial<SyncPullResponse> = {}): SyncPullResponse {
  const empty = { upserts: [], ids: [] };
  return {
    serverTime: '2026-10-27T10:00:00.000Z',
    cursor: 'cursor-1',
    full: true,
    organization: { id: 'org-1', name: 'Demo' } as never,
    tasks: empty,
    logTypes: empty,
    sites: empty,
    teams: empty,
    workLogs: empty,
    notifications: empty,
    ...overrides,
  } as SyncPullResponse;
}

export const photoFixture = (localId = 'photo-1'): LocalPhoto => ({
  localId,
  uri: `file:///offline-photos/user-1/${localId}.jpg`,
  fileName: `${localId}.jpg`,
  mimeType: 'image/jpeg',
  width: 1600,
  height: 1200,
  sizeBytes: 250_000,
});

/** A controllable clock. */
export class FakeClock {
  constructor(public now = new Date('2026-10-27T10:00:00.000Z')) {}
  read = (): Date => new Date(this.now.getTime());
  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

/** Deterministic retry: the full ceiling every time (random = 1). */
export const ceilingRetry: RetryPolicy = {
  baseDelayMs: 2000,
  maxDelayMs: 15 * 60 * 1000,
  delayMs: (attempt) => Math.min(15 * 60 * 1000, 2000 * 2 ** (attempt - 1)),
};

/** Timers that only fire when the test says so. */
export class ManualScheduler implements Scheduler {
  timers = new Map<number, { callback: () => void; ms: number }>();
  private next = 1;
  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.timers.set(handle, { callback, ms });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Fires every timer scheduled with exactly `ms` (or all when omitted). */
  fire(ms?: number): number {
    let fired = 0;
    for (const [handle, timer] of [...this.timers]) {
      if (ms === undefined || timer.ms === ms) {
        this.timers.delete(handle);
        timer.callback();
        fired += 1;
      }
    }
    return fired;
  }
}

export interface Harness {
  queue: FakeQueue;
  /** The queue the engine uses (a FakeQueue unless the test passed another). */
  realQueue: WriteQueue;
  store: FakeStore;
  photos: FakePhotos;
  api: FakeApi;
  network: FakeNetwork;
  clock: FakeClock;
  scheduler: ManualScheduler;
  needsSignIn: jest.Mock;
  puts: string[];
  putResult: { ok: true } | { ok: false; status: number; message: string };
  engine: ReturnType<typeof createSyncEngine>;
}

export function createHarness(
  overrides: Partial<SyncEngineOptions> & { queue?: WriteQueue; store?: FakeStore } = {},
): Harness {
  const realQueue: WriteQueue = overrides.queue ?? new FakeQueue();
  const queue = realQueue as FakeQueue;
  const store = overrides.store ?? new FakeStore();
  const photos = new FakePhotos();
  const api = new FakeApi();
  const network = new FakeNetwork();
  const clock = new FakeClock();
  const scheduler = new ManualScheduler();
  const needsSignIn = jest.fn();
  const harness = {
    queue,
    realQueue,
    store,
    photos,
    api,
    network,
    clock,
    scheduler,
    needsSignIn,
    puts: [] as string[],
    putResult: { ok: true } as Harness['putResult'],
  } as Harness;
  const put =
    (photo: LocalPhoto): UploadPut =>
    async () => {
      harness.puts.push(photo.localId);
      return harness.putResult;
    };
  harness.engine = createSyncEngine(
    {
      userId: 'user-1',
      store,
      queue,
      photos,
      api: api.asClient(),
      network,
      clock: clock.read,
      retry: ceilingRetry,
      onNeedsSignIn: needsSignIn,
    },
    { put, scheduler, ...overrides },
  );
  return harness;
}

/** Lets pending promise callbacks run. */
export async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}
