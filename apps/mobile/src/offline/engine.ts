import {
  offlineSyncHeaders,
  SYNC_RESOURCES,
  uploadAttachment,
  type ApiCallOptions,
  type ApiResult,
  type CreateWorkLogInput,
  type SyncPullResponse,
  type Task,
  type UploadPut,
  type WorkLog,
} from '@ops/shared';

import type { LocalPhoto } from '../storage/localPhoto';
import {
  classifyApiFailure,
  classifyLocalError,
  classifyUploadFailure,
  type ClassifiedFailure,
} from './engineErrors';
import type {
  QueueItem,
  QueueItemState,
  SyncEngine,
  SyncEngineDeps,
  SyncRunResult,
  SyncStatus,
  SyncTrigger,
} from './types';

// The sync engine (ADR-0008, sections 9, 11, 12). Pure TypeScript: every outside effect (the
// queue, the cache, the photo files, the API, the network, the clock, timers, the app's
// foreground state, the PUT of photo bytes) is injected, so tests drive it without a phone.
//
// A run pushes the queue, then pulls:
//
// 1. Push. Asks the queue for the next sendable items (at most one per record, oldest first,
//    respecting `nextAttemptAt` and blocked records) and sends each exactly as it was stored:
//    the body, the clientId, the idempotency key, with `offlineSyncHeaders` (x-device-time is the
//    phone's clock when SENDING; the worker's own time is `deviceCreatedAt` / `occurredAt` in the
//    stored body and is never rewritten). After a success the record's next item becomes
//    sendable and is picked up in the same run. An item is tried at most once per run.
// 2. Pull. `GET /sync/pull` with the stored cursor, applied to the cache in one transaction. If
//    an id of a delta pull is neither cached nor among the upserts, one full pull follows.
//
// One run at a time: a trigger during a run schedules one follow-up run, which every further
// trigger joins. Triggers: start, foreground, reconnect, enqueue (debounced), manual, timer
// (periodic while in the foreground, and at the next retry time), background.

/** The app's foreground state (React Native `AppState`, or a fake). */
export interface ForegroundSource {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}

/** Timers, injectable for tests. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SyncLog = (event: string, details?: Record<string, unknown>) => void;

export interface SyncEngineOptions {
  /** The platform PUT of a local photo's bytes to a signed URL (expo-file-system on a phone). */
  put: (photo: LocalPhoto) => UploadPut;
  /** Without one, the app is taken to be in the foreground all the time. */
  foreground?: ForegroundSource;
  scheduler?: Scheduler;
  /** Periodic run while the app is in the foreground. Default 5 minutes. */
  periodicIntervalMs?: number;
  /** Wait after a write was queued, so a burst of writes is sent by one run. Default 1 s. */
  enqueueDebounceMs?: number;
  /** A `timer` run that sent nothing pulls only if the last pull is older. Default 60 s. */
  minPullIntervalMs?: number;
  /** Safety cap of items tried in one run. Default 500. */
  maxItemsPerRun?: number;
  /**
   * An offline create was accepted with a task, site or team link the server dropped (no longer
   * usable by the worker; ADR-0008 section 3). The phone tells the worker.
   */
  onDroppedReferences?: (log: WorkLog, fields: DroppedReference[]) => void | Promise<void>;
  /** Diagnostics. Never receives a token, a password or a URL. */
  log?: SyncLog;
}

/** The engine, with two read-outs the sync screen uses besides the `SyncEngine` contract. */
export interface AppSyncEngine extends SyncEngine {
  /** Whether a run is going on now. */
  isRunning(): boolean;
  /** The phone's clock at the last successful pull (ISO), or null. */
  getLastRefreshedAt(): string | null;
}

const DEFAULT_PERIODIC_MS = 5 * 60 * 1000;
const DEFAULT_ENQUEUE_DEBOUNCE_MS = 1000;
const DEFAULT_MIN_PULL_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_ITEMS = 500;

const defaultScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type ItemOutcome =
  | {
      ok: true;
      /** Updates the cache and the queue's links; runs before `markDone`. */
      apply: () => Promise<void>;
      /** Cleans up local files; runs only after `markDone` (a crash between keeps the file). */
      after?: () => Promise<void>;
    }
  | { ok: false; failure: ClassifiedFailure };

function emptyResult(): SyncRunResult {
  return { sent: 0, failedRetryable: 0, failedPermanent: 0, pulled: false, stoppedBecause: null };
}

export type DroppedReference = 'taskId' | 'siteId' | 'teamId';
const REFERENCE_FIELDS: readonly DroppedReference[] = ['taskId', 'siteId', 'teamId'];

/** The links the worker sent with a create that the accepted log no longer has. */
export function droppedReferencesOf(
  sent: Pick<CreateWorkLogInput, DroppedReference>,
  accepted: Pick<WorkLog, DroppedReference>,
): DroppedReference[] {
  return REFERENCE_FIELDS.filter((field) => Boolean(sent[field]) && accepted[field] === null);
}

/** Pending for the indicator: waiting, being sent, or waiting for an automatic retry. */
export function waitingCount(counts: Record<QueueItemState, number>): number {
  return counts.pending + counts.sending + counts.failed_retryable;
}

/** The indicator's state from its inputs. Pure; exported for tests. */
export function statusOf(input: {
  counts: Record<QueueItemState, number>;
  running: boolean;
  online: boolean;
  needsSignIn: boolean;
  lastRefreshedAt: string | null;
}): SyncStatus {
  const pending = waitingCount(input.counts);
  const failed = input.counts.failed_permanent;
  if (input.needsSignIn) return { kind: 'needsSignIn', pending, failed };
  if (!input.online) return { kind: 'offline', pending, failed };
  if (input.running) return { kind: 'syncing', pending };
  if (failed > 0) return { kind: 'failed', failed, pending };
  if (pending > 0) return { kind: 'pending', pending };
  return { kind: 'synced', lastRefreshedAt: input.lastRefreshedAt };
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createSyncEngine(deps: SyncEngineDeps, options: SyncEngineOptions): AppSyncEngine {
  const { queue, store, photos, api, network, clock, retry } = deps;
  const scheduler = options.scheduler ?? defaultScheduler;
  const foreground = options.foreground;
  const periodicMs = options.periodicIntervalMs ?? DEFAULT_PERIODIC_MS;
  const debounceMs = options.enqueueDebounceMs ?? DEFAULT_ENQUEUE_DEBOUNCE_MS;
  const minPullIntervalMs = options.minPullIntervalMs ?? DEFAULT_MIN_PULL_INTERVAL_MS;
  const maxItems = options.maxItemsPerRun ?? DEFAULT_MAX_ITEMS;
  const log: SyncLog = options.log ?? (() => undefined);

  let started = false;
  let stopped = false;
  let needsSignIn = false;
  let running: Promise<SyncRunResult> | null = null;
  let followUp: Promise<SyncRunResult> | null = null;
  let lastRefreshedAt: string | null = null;
  let lastPullAt = 0;
  let lastPendingCount = 0;
  let status: SyncStatus = { kind: 'synced', lastRefreshedAt: null };
  const listeners = new Set<(status: SyncStatus) => void>();
  const unsubscribers: (() => void)[] = [];
  let periodicTimer: unknown = null;
  let retryTimer: unknown = null;
  let debounceTimer: unknown = null;

  // ------------------------------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------------------------------

  function emit(next: SyncStatus): void {
    if (sameStatus(status, next)) return;
    status = next;
    for (const listener of listeners) listener(status);
  }

  async function refreshStatus(): Promise<Record<QueueItemState, number> | null> {
    try {
      const counts = await queue.counts();
      emit(
        statusOf({
          counts,
          running: running !== null,
          online: network.isOnline(),
          needsSignIn,
          lastRefreshedAt,
        }),
      );
      return counts;
    } catch (error) {
      log('status_failed', { message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Sending one item
  // ------------------------------------------------------------------------------------------

  function requestOptions(item: QueueItem): ApiCallOptions {
    return {
      headers: offlineSyncHeaders({ idempotencyKey: item.idempotencyKey, deviceTime: clock() }),
    };
  }

  /** The server id of a log known by its clientId (cached once its create was accepted). */
  async function serverIdOf(workLogClientId: string): Promise<string | null> {
    // The queue's durable link first: it survives a cleared cache ("keep for later" sign-out).
    const linked = await queue.serverIdOf(workLogClientId);
    if (linked !== null) return linked;
    const cached = await store.getWorkLogByClientId(workLogClientId);
    return cached?.id ?? null;
  }

  /** Set when an item waited for a log's server id: the run then pulls, whatever the trigger. */
  let missingLink = false;

  /**
   * The log's server id is not known on the phone (yet). Never final: a pull may bring the log
   * back; the item is retried with backoff after it.
   */
  function notCached(): ItemOutcome {
    missingLink = true;
    return {
      ok: false,
      failure: {
        disposition: 'retryable',
        connection: false,
        error: {
          code: 'not_found',
          message: 'The work log is not known on this phone yet',
          status: null,
        },
      },
    };
  }

  function fromWorkLog(item: QueueItem, result: ApiResult<WorkLog>): ItemOutcome {
    if (!result.ok) return { ok: false, failure: classifyApiFailure(result.failure) };
    const log = result.data;
    return {
      ok: true,
      apply: async () => {
        await store.upsert('workLogs', [log]);
        await queue.rebaseVersion(item.recordKey, log.version);
      },
    };
  }

  function fromTask(item: QueueItem, result: ApiResult<Task>): ItemOutcome {
    if (!result.ok) return { ok: false, failure: classifyApiFailure(result.failure) };
    const task = result.data;
    return {
      ok: true,
      apply: async () => {
        await store.upsert('tasks', [task]);
        await queue.rebaseVersion(item.recordKey, task.version);
      },
    };
  }

  async function perform(item: QueueItem): Promise<ItemOutcome> {
    const mutation = item.mutation;
    switch (mutation.kind) {
      case 'createWorkLog': {
        const result = await api.workLogs.create(mutation.body, requestOptions(item));
        const outcome = fromWorkLog(item, result);
        if (!outcome.ok || !result.ok) return outcome;
        const accepted = result.data;
        const dropped = droppedReferencesOf(mutation.body, accepted);
        const notify = options.onDroppedReferences;
        return {
          ok: true,
          apply: async () => {
            // Durable before the create leaves the queue: later edits and photos need it even
            // if the cache write below fails or the cache is cleared.
            await queue.linkServerId(mutation.body.clientId, accepted.id);
            await outcome.apply();
            if (dropped.length > 0 && notify) {
              log('dropped_references', { fields: dropped });
              await notify(accepted, dropped);
            }
          },
        };
      }
      case 'updateWorkLog': {
        const id = await serverIdOf(mutation.workLogClientId);
        if (id === null) return notCached();
        return fromWorkLog(
          item,
          await api.workLogs.update(id, mutation.body, requestOptions(item)),
        );
      }
      case 'changeWorkLogStatus': {
        const id = await serverIdOf(mutation.workLogClientId);
        if (id === null) return notCached();
        return fromWorkLog(
          item,
          await api.workLogs.changeStatus(id, mutation.body, requestOptions(item)),
        );
      }
      case 'changeTaskStatus':
        return fromTask(
          item,
          await api.tasks.changeStatus(mutation.taskId, mutation.body, requestOptions(item)),
        );
      case 'uploadAttachment': {
        const workLogId = mutation.workLogId ?? (await serverIdOf(mutation.workLogClientId));
        if (workLogId === null) return notCached();
        if (!(await photos.exists(mutation.photo))) {
          return photoGone(item, workLogId, mutation);
        }
        const result = await uploadAttachment(
          api.attachments,
          {
            workLogId,
            file: {
              clientId: mutation.attachmentClientId,
              fileName: mutation.photo.fileName,
              mimeType: mutation.photo.mimeType,
              sizeBytes: mutation.photo.sizeBytes,
            },
            put: options.put(mutation.photo),
            checkpoint: mutation.checkpoint,
            requestOptions: requestOptions(item),
          },
          clock,
        );
        const before = mutation.checkpoint;
        if (
          before.attachmentId !== result.checkpoint.attachmentId ||
          before.stored !== result.checkpoint.stored
        ) {
          await queue.saveCheckpoint(item.id, result.checkpoint);
        }
        if (!result.ok) return { ok: false, failure: classifyUploadFailure(result.failure) };
        return {
          ok: true,
          apply: async () => undefined,
          after: async () => {
            await photos.delete(mutation.photo.localId);
          },
        };
      }
    }
  }

  type UploadMutation = Extract<QueueItem['mutation'], { kind: 'uploadAttachment' }>;

  /**
   * The photo file is gone. If an earlier attempt already created the attachment (the app may
   * have died after the upload finished, before the item was removed), a repeated start with
   * the same clientId says whether the server has it ready; only otherwise is it missing.
   */
  async function photoGone(
    item: QueueItem,
    workLogId: string,
    mutation: UploadMutation,
  ): Promise<ItemOutcome> {
    const missing: ItemOutcome = {
      ok: false,
      failure: {
        disposition: 'permanent',
        connection: false,
        error: {
          code: 'photo_missing',
          message: 'The photo file is no longer on this phone',
          status: null,
        },
      },
    };
    if (mutation.checkpoint.attachmentId === null) return missing;
    const started = await api.attachments.startUpload(
      workLogId,
      {
        clientId: mutation.attachmentClientId,
        fileName: mutation.photo.fileName,
        mimeType: mutation.photo.mimeType,
        sizeBytes: mutation.photo.sizeBytes,
      },
      requestOptions(item),
    );
    if (!started.ok) {
      const failure = classifyApiFailure(started.failure);
      return failure.disposition === 'permanent' ? missing : { ok: false, failure };
    }
    if (started.data.upload === null && started.data.attachment.status === 'ready') {
      return { ok: true, apply: async () => undefined };
    }
    return missing;
  }

  type Sent = 'done' | 'retryable' | 'permanent' | 'needsSignIn' | 'connection' | 'skipped';

  async function send(listed: QueueItem): Promise<Sent> {
    // Send the copy the queue hands over when claiming it, never the listed one: changes may
    // have been merged into it meanwhile, or it may have been discarded (null).
    const item = await queue.markSending(listed.id, clock());
    if (item === null) return 'skipped';
    let outcome: ItemOutcome;
    try {
      outcome = await perform(item);
    } catch (error) {
      outcome = { ok: false, failure: classifyLocalError(error) };
    }

    if (outcome.ok) {
      try {
        await outcome.apply();
      } catch (error) {
        // The server accepted it; a failed cache update is repaired by the pull.
        log('apply_failed', {
          kind: item.mutation.kind,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await queue.markDone(item.id);
      if (outcome.after) {
        await outcome.after().catch((error: unknown) =>
          log('after_failed', {
            kind: item.mutation.kind,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      log('sent', { kind: item.mutation.kind, recordKey: item.recordKey });
      return 'done';
    }

    const { failure } = outcome;
    const now = clock();
    if (failure.disposition === 'needsSignIn') {
      // Not the item's fault: kept, retryable at once, for the next session of this user.
      await queue.markFailed(item.id, failure.error, false, null, now);
      return 'needsSignIn';
    }
    if (failure.disposition === 'permanent') {
      await queue.markFailed(item.id, failure.error, true, null, now);
      log('refused', { kind: item.mutation.kind, code: failure.error.code });
      return 'permanent';
    }
    const delay = retry.delayMs(item.attempts + 1);
    await queue.markFailed(item.id, failure.error, false, new Date(now.getTime() + delay), now);
    log('retry_later', { kind: item.mutation.kind, code: failure.error.code, delayMs: delay });
    return failure.connection ? 'connection' : 'retryable';
  }

  // ------------------------------------------------------------------------------------------
  // Pull
  // ------------------------------------------------------------------------------------------

  async function hasUnknownIds(pull: SyncPullResponse): Promise<boolean> {
    for (const resource of SYNC_RESOURCES) {
      const ids = pull[resource].ids;
      if (ids.length === 0) continue;
      const cached = new Set((await store.list(resource)).map((record) => record.id));
      if (ids.some((id) => !cached.has(id))) return true;
    }
    return false;
  }

  /** Returns null on success, else why it failed. */
  async function pull(): Promise<ClassifiedFailure | null> {
    const meta = await store.getSyncMeta();
    let result = await api.sync.pull(meta.cursor ? { cursor: meta.cursor } : {});
    if (!result.ok) return classifyApiFailure(result.failure);
    await store.applyPull(result.data, clock());
    if (!result.data.full && (await hasUnknownIds(result.data))) {
      log('pull_repair');
      result = await api.sync.pull({});
      if (!result.ok) return classifyApiFailure(result.failure);
      await store.applyPull(result.data, clock());
    }
    const refreshed = (await store.getSyncMeta()).lastRefreshedAt;
    lastRefreshedAt = refreshed ?? clock().toISOString();
    lastPullAt = clock().getTime();
    return null;
  }

  // ------------------------------------------------------------------------------------------
  // A run
  // ------------------------------------------------------------------------------------------

  function enterNeedsSignIn(): void {
    if (!needsSignIn) {
      needsSignIn = true;
      log('needs_sign_in');
      deps.onNeedsSignIn();
    }
  }

  /** "A manual retry or a reconnect resets the wait" (ADR-0008). */
  async function resetRetryWaits(): Promise<void> {
    const now = clock();
    for (const item of await queue.list()) {
      if (item.state === 'failed_retryable') await queue.retry(item.id, now);
    }
  }

  async function run(trigger: SyncTrigger): Promise<SyncRunResult> {
    const result = emptyResult();
    const attempted = new Set<string>();
    missingLink = false;
    log('run', { trigger });
    try {
      if (trigger === 'reconnect' || trigger === 'manual') await resetRetryWaits();
      await refreshStatus();

      outer: while (attempted.size < maxItems) {
        const batch = (await queue.nextBatch(clock())).filter((item) => !attempted.has(item.id));
        if (batch.length === 0) break;
        for (const item of batch) {
          if (stopped) {
            result.stoppedBecause = 'stopped';
            break outer;
          }
          if (!network.isOnline()) {
            result.stoppedBecause = 'offline';
            break outer;
          }
          attempted.add(item.id);
          const sent = await send(item);
          await refreshStatus();
          if (sent === 'skipped') continue;
          if (sent === 'done') result.sent += 1;
          else if (sent === 'permanent') result.failedPermanent += 1;
          else if (sent === 'retryable') result.failedRetryable += 1;
          else if (sent === 'connection') {
            result.failedRetryable += 1;
            result.stoppedBecause = 'offline';
            break outer;
          } else {
            result.stoppedBecause = 'needsSignIn';
            enterNeedsSignIn();
            break outer;
          }
        }
      }

      const pullDue =
        missingLink ||
        trigger !== 'timer' ||
        result.sent > 0 ||
        clock().getTime() - lastPullAt >= minPullIntervalMs;
      if (result.stoppedBecause === null && stopped) result.stoppedBecause = 'stopped';
      if (result.stoppedBecause === null && pullDue) {
        const failure = await pull();
        if (failure === null) {
          result.pulled = true;
        } else if (failure.disposition === 'needsSignIn') {
          result.stoppedBecause = 'needsSignIn';
          enterNeedsSignIn();
        } else {
          log('pull_failed', { code: failure.error.code });
          if (failure.connection) result.stoppedBecause = 'offline';
        }
      }

      if (result.stoppedBecause === null && !stopped) {
        // Written while this run was busy (after its last look at the queue): one more run.
        const leftover = (await queue.nextBatch(clock())).filter((item) => !attempted.has(item.id));
        if (leftover.length > 0) scheduleFollowUp('enqueue');
      }
    } catch (error) {
      log('run_failed', { message: error instanceof Error ? error.message : String(error) });
    }
    return result;
  }

  function scheduleFollowUp(trigger: SyncTrigger): Promise<SyncRunResult> {
    if (running === null) return execute(trigger);
    followUp ??= running.then(() => {
      followUp = null;
      return syncNow(trigger);
    });
    return followUp;
  }

  function execute(trigger: SyncTrigger): Promise<SyncRunResult> {
    const current = run(trigger).finally(async () => {
      running = null;
      await refreshStatus();
      await scheduleRetryWakeUp();
    });
    running = current;
    return current;
  }

  function syncNow(trigger: SyncTrigger = 'manual'): Promise<SyncRunResult> {
    if (stopped) return Promise.resolve({ ...emptyResult(), stoppedBecause: 'stopped' });
    if (trigger === 'manual' || trigger === 'start') {
      // The worker asked, or a new session started: try again even after "sign in again".
      needsSignIn = false;
    } else if (needsSignIn) {
      return Promise.resolve({ ...emptyResult(), stoppedBecause: 'needsSignIn' });
    }
    if (running !== null) return scheduleFollowUp(trigger);
    if (!network.isOnline()) {
      void refreshStatus();
      return Promise.resolve({ ...emptyResult(), stoppedBecause: 'offline' });
    }
    return execute(trigger);
  }

  // ------------------------------------------------------------------------------------------
  // Timers and triggers
  // ------------------------------------------------------------------------------------------

  function clearTimer(handle: unknown): null {
    if (handle !== null) scheduler.clearTimeout(handle);
    return null;
  }

  function schedulePeriodic(): void {
    periodicTimer = clearTimer(periodicTimer);
    if (stopped || (foreground && !foreground.isActive())) return;
    periodicTimer = scheduler.setTimeout(() => {
      periodicTimer = null;
      void syncNow('timer').finally(schedulePeriodic);
    }, periodicMs);
  }

  /** Wakes up when the earliest automatic retry is due (the periodic run covers the rest). */
  async function scheduleRetryWakeUp(): Promise<void> {
    retryTimer = clearTimer(retryTimer);
    if (stopped || needsSignIn) return;
    let earliest = Number.POSITIVE_INFINITY;
    try {
      for (const item of await queue.list()) {
        if (item.state !== 'failed_retryable' || item.nextAttemptAt === null) continue;
        earliest = Math.min(earliest, Date.parse(item.nextAttemptAt));
      }
    } catch {
      return;
    }
    if (!Number.isFinite(earliest)) return;
    const wait = Math.max(0, earliest - clock().getTime());
    if (wait >= periodicMs) return;
    retryTimer = scheduler.setTimeout(() => {
      retryTimer = null;
      void syncNow('timer');
    }, wait);
  }

  function onQueueChanged(): void {
    void (async () => {
      const counts = await refreshStatus();
      if (counts === null) return;
      const grew = counts.pending > lastPendingCount;
      lastPendingCount = counts.pending;
      if (!grew || running !== null || stopped) return;
      debounceTimer = clearTimer(debounceTimer);
      debounceTimer = scheduler.setTimeout(() => {
        debounceTimer = null;
        void syncNow('enqueue');
      }, debounceMs);
    })();
  }

  function start(): void {
    if (started || stopped) return;
    started = true;
    let wasOnline = network.isOnline();
    unsubscribers.push(
      network.subscribe((online) => {
        const regained = online && !wasOnline;
        wasOnline = online;
        void refreshStatus();
        if (regained) void syncNow('reconnect');
      }),
      queue.subscribe(onQueueChanged),
    );
    if (foreground) {
      unsubscribers.push(
        foreground.subscribe((active) => {
          if (active) {
            void syncNow('foreground');
            schedulePeriodic();
          } else {
            periodicTimer = clearTimer(periodicTimer);
          }
        }),
      );
    }
    void (async () => {
      try {
        const recovered = await queue.recoverInterrupted();
        if (recovered > 0) log('recovered', { count: recovered });
        lastRefreshedAt = (await store.getSyncMeta()).lastRefreshedAt;
        lastPendingCount = (await queue.counts()).pending;
      } catch (error) {
        log('start_failed', { message: error instanceof Error ? error.message : String(error) });
      }
      await refreshStatus();
      if (!stopped) void syncNow('start');
      schedulePeriodic();
    })();
  }

  async function stop(): Promise<void> {
    stopped = true;
    periodicTimer = clearTimer(periodicTimer);
    retryTimer = clearTimer(retryTimer);
    debounceTimer = clearTimer(debounceTimer);
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    const current = running;
    if (current !== null) await current.catch(() => undefined);
  }

  return {
    start,
    stop,
    syncNow,
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      listener(status);
      return () => {
        listeners.delete(listener);
      };
    },
    isRunning: () => running !== null,
    getLastRefreshedAt: () => lastRefreshedAt,
  };
}
