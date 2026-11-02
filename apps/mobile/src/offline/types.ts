// Phase 5 contracts of the phone's offline layer (ADR-0008). Interfaces only: the local store,
// the write queue, the local photo store and the sync engine are implemented against these.
//
// Ground rules (ADR-0008):
// - One SQLite database per signed-in user id (`ops-<userId>.db`, expo-sqlite, app-private
//   storage). Nothing of one user is ever read from, or sent from, another user's database.
// - Screens keep calling `src/data/repositories.ts`; the offline repositories put writes in the
//   queue and answer at once. Screens never call the queue or the API directly.
// - The server is the source of truth: the cache is replaced by what `GET /sync/pull` returns;
//   queued writes are requests the server judges when they arrive.
// - A queued write is never dropped silently: it ends `done` (removed) or `failed_permanent`
//   (kept until the worker discards it, copies it, or resubmits it as a new log).

import type {
  AiCaptureAudioMimeType,
  ApiClient,
  ApiErrorCode,
  AppNotification,
  AuthUser,
  ChangeTaskStatus,
  ChangeWorkLogStatus,
  CreateWorkLogInput,
  SmartCapture,
  SmartCaptureContext,
  LogType,
  OrganizationSummary,
  Site,
  SyncCursor,
  SyncPullResponse,
  Task,
  Team,
  UpdateWorkLog,
  WorkLog,
} from '@ops/shared';

import type { LocalPhoto } from '../storage/localPhoto';

// ---------------------------------------------------------------------------------------------
// Local store (read cache)
// ---------------------------------------------------------------------------------------------

/** The cached resources, keyed like the `GET /sync/pull` response. */
export interface CachedResources {
  tasks: Task;
  logTypes: LogType;
  sites: Site;
  teams: Team;
  workLogs: WorkLog;
  notifications: AppNotification;
}
export type CachedResourceName = keyof CachedResources;

/** What is known about the last successful pull. */
export interface SyncMeta {
  /** The cursor to send with the next pull; null before the first pull (a full pull). */
  cursor: SyncCursor | null;
  /** The phone's clock when the last pull succeeded (ISO): "last refreshed". Null: never. */
  lastRefreshedAt: string | null;
  /** `serverTime` of the last pull (ISO). */
  lastServerTime: string | null;
  /** The organization summary of the last pull (edit window, backdating limit). */
  organization: OrganizationSummary | null;
}

/**
 * The signed-in user's read cache, in their own database. All methods are async and never
 * throw for "not found" (they answer null or an empty list).
 */
export interface LocalStore {
  /** The user this store belongs to. */
  readonly userId: string;

  list<Name extends CachedResourceName>(resource: Name): Promise<CachedResources[Name][]>;
  get<Name extends CachedResourceName>(
    resource: Name,
    id: string,
  ): Promise<CachedResources[Name] | null>;
  /** A cached work log by its clientId (offline-created logs are known by clientId first). */
  getWorkLogByClientId(clientId: string): Promise<WorkLog | null>;

  /** Inserts or replaces records (by id). */
  upsert<Name extends CachedResourceName>(
    resource: Name,
    records: readonly CachedResources[Name][],
  ): Promise<void>;
  /** Deletes every cached record of the resource whose id is not in `ids` (pull pruning). */
  retainOnly(resource: CachedResourceName, ids: readonly string[]): Promise<void>;
  /** Replaces the whole resource (a full pull). */
  replaceAll<Name extends CachedResourceName>(
    resource: Name,
    records: readonly CachedResources[Name][],
  ): Promise<void>;

  getSyncMeta(): Promise<SyncMeta>;
  setSyncMeta(meta: Partial<SyncMeta>): Promise<void>;

  /**
   * Applies one pull in a single SQLite transaction: upserts, prunes by `ids` (or replaces all
   * when `full`), stores the new cursor, `serverTime` and organization, and stamps
   * `lastRefreshedAt` with `refreshedAt`.
   */
  applyPull(pull: SyncPullResponse, refreshedAt: Date): Promise<void>;

  /** Deletes the cached reads (not the queue). Used on sign-out once the queue is empty. */
  clearCache(): Promise<void>;
  /** Subscribes to any change of the cache (for re-rendering). Returns the unsubscribe. */
  subscribe(listener: (resource: CachedResourceName) => void): () => void;
  /** Closes the database (sign-out, user switch). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Write queue
// ---------------------------------------------------------------------------------------------

/**
 * The writes the queue can hold. Every one carries what the server needs to stay idempotent:
 * the `clientId` (creates, photos) or an `idempotencyKey` (sent as `Idempotency-Key`).
 */
export type QueuedMutation =
  | {
      kind: 'createWorkLog';
      /** Includes `clientId` and `attachmentClientIds` (the photos of this submission). */
      body: CreateWorkLogInput;
    }
  | {
      kind: 'updateWorkLog';
      /** The log's clientId: its server id may not exist yet when this is queued. */
      workLogClientId: string;
      /** `expectedVersion` is the cached version when queued; the engine may chain it (ADR). */
      body: UpdateWorkLog;
    }
  | {
      kind: 'changeWorkLogStatus';
      workLogClientId: string;
      body: ChangeWorkLogStatus;
    }
  | {
      kind: 'changeTaskStatus';
      taskId: string;
      body: ChangeTaskStatus;
    }
  | {
      kind: 'uploadAttachment';
      workLogClientId: string;
      /**
       * The log's server id when already known (an online log, or a photo migrated from the
       * Phase 4 AsyncStorage upload queue); otherwise resolved from `workLogClientId` once the
       * create has been accepted.
       */
      workLogId: string | null;
      /** The attachment's clientId; declared in the log's create when part of the submission. */
      attachmentClientId: string;
      /** The prepared photo, kept in the local photo store until the upload is done. */
      photo: LocalPhoto;
      /** Upload progress across attempts (`UploadCheckpoint` of @ops/shared). */
      checkpoint: { attachmentId: string | null; stored: boolean };
    }
  | SmartCaptureMutation
  | DiscardSmartCaptureMutation;
export type QueuedMutationKind = QueuedMutation['kind'];

// ---------------------------------------------------------------------------------------------
// Smart capture in the queue (Phase 7, ADR-0010): `SmartCaptureMutation` and
// `DiscardSmartCaptureMutation` are part of `QueuedMutation`; record key
// `smartCapture:<captureClientId>` (`src/offline/smartCaptureSteps.ts` runs them).
// ---------------------------------------------------------------------------------------------

/**
 * A voice note recorded on the phone, kept in the app's private documents (per user, like the
 * offline photos) until the capture is processed, then deleted.
 */
export interface LocalAudio {
  localId: string;
  /** `file://` URI in the app's document folder. */
  uri: string;
  fileName: string;
  mimeType: AiCaptureAudioMimeType;
  sizeBytes: number;
  durationMs: number;
}

/** What the worker captured. A photo is the prepared JPEG of `LocalPhoto`. */
export type SmartCaptureInput =
  | { kind: 'voice'; audio: LocalAudio }
  | { kind: 'photo'; photo: LocalPhoto; note: string | null }
  | { kind: 'text'; text: string };

/**
 * "Speak" or "Snap" (or a typed note) made while offline, or not yet processed. Record key
 * `smartCapture:<captureClientId>`; its own record, so it never waits for, or blocks, a log.
 *
 * The engine runs it in steps, saving `checkpoint` between them, each safe to repeat:
 * 1. `POST /ai/capture` with `clientId = captureClientId` (a repeat returns the same capture);
 * 2. for voice and photo, PUT the bytes to `upload` (renew with `POST /ai/capture/:id/upload-url`
 *    when expired), then
 * 3. `POST /ai/capture/:id/process`.
 * The item is `done` when the capture is `proposed` or `failed`: the phone then shows the
 * proposal (or "couldn't understand, please fill in manually" with the transcript) for review.
 * Confirming is an ordinary `createWorkLog` with `source: 'ai_assisted'` and `aiProposalId`,
 * queued like any log. `ai_disabled` and `ai_limit_reached` are final (`failed_permanent`: the
 * worker fills the form by hand, the recording stays until discarded); `ai_unavailable`,
 * `rate_limited` and network errors are retried. The worker can always fill the form manually
 * while it waits.
 */
export interface SmartCaptureMutation {
  kind: 'smartCapture';
  /** The capture's clientId, generated when the worker recorded it. */
  captureClientId: string;
  input: SmartCaptureInput;
  /** `capturedAt` is the phone's clock at recording time, not at sending time. */
  context: SmartCaptureContext;
  /** Progress across attempts. */
  checkpoint: SmartCaptureCheckpoint;
}

/** Progress of a queued smart capture across attempts. */
export interface SmartCaptureCheckpoint {
  /** The server's capture id once `POST /ai/capture` answered. */
  captureId: string | null;
  /** The bytes of a voice note or photo reached the storage (always true for text). */
  uploaded: boolean;
  processed: boolean;
}

/**
 * The worker discarded a capture the server already has (`POST /ai/capture/:id/discard`). A
 * capture still waiting in the queue is simply removed from it instead. Same record key as the
 * capture, so it is sent after it.
 */
export interface DiscardSmartCaptureMutation {
  kind: 'discardSmartCapture';
  captureClientId: string;
  captureId: string;
}

/**
 * A capture as the phone keeps it (table `smart_captures` of the user's database, key
 * `captureClientId`): what was captured, and the server's answer once processed. Removed when the
 * worker confirms (the log takes over) or discards it.
 */
export interface LocalSmartCapture {
  captureClientId: string;
  input: SmartCaptureInput;
  context: SmartCaptureContext;
  /** The processed capture (`proposed` or `failed`), or null while it waits in the queue. */
  capture: SmartCapture | null;
  /** The phone's clock when the worker captured it (ISO). */
  createdAt: string;
}

/** Where the engine puts a processed capture (the user's `smart_captures` table). */
export interface SmartCaptureResults {
  saveResult(captureClientId: string, capture: SmartCapture): Promise<void>;
}

/**
 * Voice notes waiting to be sent, as files in a folder per user (`offline-audio/<userId>/`), like
 * the offline photos. A file is deleted once its capture was processed, or when it is discarded.
 */
export interface LocalAudioStore {
  readonly userId: string;
  /** Moves a recorded file into the store (`audio.uri` is where the recorder left it). */
  save(audio: LocalAudio): Promise<LocalAudio>;
  exists(audio: LocalAudio): Promise<boolean>;
  delete(localId: string): Promise<void>;
  /** Deletes every file not referenced by `keepLocalIds` (start-up cleanup of orphans). */
  deleteAllExcept(keepLocalIds: readonly string[]): Promise<number>;
  clear(): Promise<void>;
}

/**
 * - `pending`: waiting for its turn (or for `nextAttemptAt`).
 * - `sending`: being sent now. On app start, a `sending` item is reset to `pending` (the app
 *   died mid-send; the idempotency key / clientId makes the resend safe).
 * - `failed_retryable`: failed for a reason that may pass (no network, timeout, 5xx, 429,
 *   `request_in_progress`); retried automatically at `nextAttemptAt`.
 * - `failed_permanent`: the server refused it for good (a conflict rule, validation, 403/404).
 *   Kept and shown until the worker acts. It blocks later items of the same record.
 * - `done`: accepted; removed from the queue right after the cache is updated.
 */
export type QueueItemState =
  'pending' | 'sending' | 'failed_retryable' | 'failed_permanent' | 'done';

/** Why the last attempt failed. Never holds a token or a password. */
export interface QueueItemError {
  /** The API's code; `network` / `timeout` / `invalid_response` when there was no API error body. */
  code:
    ApiErrorCode | 'network' | 'timeout' | 'invalid_response' | 'photo_missing' | 'audio_missing';
  /** For logs and as a fallback; the screen shows `t(...)` by `code`. */
  message: string;
  /** HTTP status, or null without one. */
  status: number | null;
}

export interface QueueItem {
  /** Local id of the item (UUID). */
  id: string;
  /** Strictly increasing per database: the global enqueue order. */
  seq: number;
  /**
   * The record the write is about: `workLog:<clientId>` or `task:<taskId>`. Items of one record
   * are sent strictly in `seq` order, one at a time; different records do not wait for each
   * other, except that a record's items wait while an earlier item of the same record failed.
   */
  recordKey: string;
  mutation: QueuedMutation;
  state: QueueItemState;
  /** Sent as `Idempotency-Key` on routes that honour it. Same on every attempt. */
  idempotencyKey: string;
  /** Automatic attempts so far (reset by a manual retry). */
  attempts: number;
  /** When it may be tried next (ISO); null = now. */
  nextAttemptAt: string | null;
  lastError: QueueItemError | null;
  /** The phone's clock when the worker made the change (ISO). */
  createdAt: string;
  updatedAt: string;
}

/** What the queue answers when asked to hold a write. */
export interface EnqueueResult {
  item: QueueItem;
  /** True when the write was merged into an earlier unsent item of the same record. */
  coalesced: boolean;
}

export interface WriteQueue {
  readonly userId: string;
  /**
   * Holds a write. Rules: an `updateWorkLog` of a log whose `createWorkLog` is still `pending`
   * is merged into that create's body (same clientId); consecutive unsent `updateWorkLog` items
   * of one log are merged (later fields win); everything else is appended.
   */
  enqueue(mutation: QueuedMutation, now: Date): Promise<EnqueueResult>;
  /** Every item not `done`, in `seq` order. */
  list(): Promise<QueueItem[]>;
  /** The items that may be sent now, at most one per record key, in `seq` order. */
  nextBatch(now: Date): Promise<QueueItem[]>;
  get(id: string): Promise<QueueItem | null>;
  /** Counts by state, for the status indicator. */
  counts(): Promise<Record<QueueItemState, number>>;

  /**
   * Claims an item for sending, in one transaction: re-reads it and, only if it still exists and
   * is `pending` or `failed_retryable`, marks it `sending` and returns that CURRENT copy (with
   * every change merged into it since it was listed). Null: discarded, or not sendable now; the
   * engine skips it. A `sending` item is never merged into again, so what the engine sends is
   * exactly what `markDone` removes.
   */
  markSending(id: string, now: Date): Promise<QueueItem | null>;
  /** Removes the item (it reached `done`). Only an item in `sending` is removed. */
  markDone(id: string): Promise<void>;
  /**
   * Remembers durably (in the queue's part of the database, which survives `clearCache`) the
   * server id a log's create was given, so its later queued edits and photos can be sent even
   * when the read cache is cleared. Forgotten once the record has no queued item left.
   */
  linkServerId(workLogClientId: string, serverId: string): Promise<void>;
  /** The server id remembered by `linkServerId`, or null. */
  serverIdOf(workLogClientId: string): Promise<string | null>;
  markFailed(
    id: string,
    error: QueueItemError,
    permanent: boolean,
    nextAttemptAt: Date | null,
    now: Date,
  ): Promise<void>;
  /** Saves upload progress of an `uploadAttachment` item between steps. */
  saveCheckpoint(
    id: string,
    checkpoint: { attachmentId: string | null; stored: boolean },
  ): Promise<void>;
  /** Saves the progress of a `smartCapture` item between steps (Phase 7). */
  saveCaptureCheckpoint(id: string, checkpoint: SmartCaptureCheckpoint): Promise<void>;
  /** Rewrites `expectedVersion` of the next unsent items of a record after a success. */
  rebaseVersion(recordKey: string, version: number): Promise<void>;
  /** Sets every `sending` item back to `pending` (app start). */
  recoverInterrupted(): Promise<number>;

  /** Manual retry: back to `pending`, attempts 0, now. Also for `failed_permanent`. */
  retry(id: string, now: Date): Promise<void>;
  /** Deletes the item (and, for a create, the record's later items and their local photos). */
  discard(id: string): Promise<void>;
  /**
   * For a permanently refused log edit or create: a new `createWorkLog` with a fresh clientId
   * and the same content (occurredAt clamped by nothing: the server judges it), and the photos
   * re-declared under fresh attachment clientIds. Returns the new create item.
   */
  resubmitAsNew(id: string, now: Date): Promise<QueueItem>;
  /** The worker's content of an item as plain text (copy to the clipboard). */
  copyText(id: string): Promise<string>;
  /** Number of items not `done`. Sign-out checks it. */
  pendingCount(): Promise<number>;
  /** Deletes the whole queue and its photos (explicit "discard and sign out"). */
  clear(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Automatic retry policy (ADR-0008): exponential backoff with full jitter and a cap. */
export interface RetryPolicy {
  /** First delay. Default 2 000 ms. */
  baseDelayMs: number;
  /** Largest delay. Default 15 minutes. */
  maxDelayMs: number;
  /**
   * Delay before attempt `attempt` (1-based): random in [0, min(maxDelayMs, base * 2^(attempt-1))].
   * There is no attempt limit for retryable failures: they wait for the cap and keep trying.
   */
  delayMs(attempt: number, random?: () => number): number;
}

// ---------------------------------------------------------------------------------------------
// Local photo store
// ---------------------------------------------------------------------------------------------

/** Default local storage limit for offline photos: 500 MB, warning at 80%. */
export const DEFAULT_PHOTO_STORAGE_LIMIT_BYTES = 500 * 1024 * 1024;
export const PHOTO_STORAGE_WARNING_RATIO = 0.8;

export type PhotoStorageLevel = 'ok' | 'warning' | 'full';

export interface PhotoStorageUsage {
  usedBytes: number;
  limitBytes: number;
  level: PhotoStorageLevel;
}

/**
 * Prepared photos waiting for upload, as files under the app's private document directory, in
 * a folder per user (`offline-photos/<userId>/`). A photo is deleted after its upload completed
 * and the log is cached with it, or when its queue item is discarded.
 */
export interface LocalPhotoStore {
  readonly userId: string;
  /** Moves an already resized photo into the store. Refuses with `full` past the limit. */
  save(photo: LocalPhoto): Promise<{ ok: true; photo: LocalPhoto } | { ok: false; reason: 'full' }>;
  /** Whether the file still exists (it may have been removed by the OS or the user). */
  exists(photo: LocalPhoto): Promise<boolean>;
  delete(localId: string): Promise<void>;
  /** Deletes every file not referenced by `keepLocalIds` (start-up cleanup of orphans). */
  deleteAllExcept(keepLocalIds: readonly string[]): Promise<number>;
  totalBytes(): Promise<number>;
  usage(): Promise<PhotoStorageUsage>;
  /** Whether a photo of `sizeBytes` may be added now. */
  canAdd(sizeBytes: number): Promise<boolean>;
  /** Deletes the user's whole folder. */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------------------------

export type SyncStatus =
  | { kind: 'synced'; lastRefreshedAt: string | null }
  | { kind: 'syncing'; pending: number }
  | { kind: 'pending'; pending: number }
  | { kind: 'failed'; failed: number; pending: number }
  | { kind: 'offline'; pending: number; failed: number }
  /** The refresh token is gone or refused: the queue is kept until the same user signs in. */
  | { kind: 'needsSignIn'; pending: number; failed: number };

/** Why a sync run started (for logs and tests). */
export type SyncTrigger =
  'start' | 'foreground' | 'reconnect' | 'enqueue' | 'manual' | 'background' | 'timer';

export interface SyncRunResult {
  /** Items accepted by the server in this run. */
  sent: number;
  failedRetryable: number;
  failedPermanent: number;
  /** Whether a pull succeeded in this run. */
  pulled: boolean;
  /** Set when the run stopped early. */
  stoppedBecause: 'offline' | 'needsSignIn' | 'stopped' | null;
}

/**
 * Sends the queue and pulls fresh data. One run at a time (a second `syncNow` while running
 * joins the running one). A run: push the queue (records in parallel is not required; order per
 * record is), then pull. Runs on start, when the app comes to the foreground, when the network
 * returns, after an enqueue (debounced), on "Sync now", and from the background task when the OS
 * allows it.
 */
export interface SyncEngine {
  start(): void;
  /** Stops timers and listeners; a running request is let finish but nothing new is started. */
  stop(): Promise<void>;
  syncNow(trigger?: SyncTrigger): Promise<SyncRunResult>;
  getStatus(): SyncStatus;
  /** Calls the listener with the current status at once and on every change. */
  subscribe(listener: (status: SyncStatus) => void): () => void;
}

/** What the engine needs from the outside, so tests can drive it without a phone. */
export interface SyncEngineDeps {
  userId: string;
  store: LocalStore;
  queue: WriteQueue;
  photos: LocalPhotoStore;
  /** The authenticated API client of the session (`authSession.client`). */
  api: ApiClient;
  network: NetworkMonitor;
  clock: () => Date;
  retry: RetryPolicy;
  /** Called when the session cannot be renewed; the app shows sign-in for the same user. */
  onNeedsSignIn: () => void;
  /** Phase 7: the user's voice notes waiting to be sent (smart capture). */
  audio?: LocalAudioStore;
  /** Phase 7: where processed captures go, for the review screen. */
  captures?: SmartCaptureResults;
}

/** Connectivity, from @react-native-community/netinfo (or a fake in tests). */
export interface NetworkMonitor {
  isOnline(): boolean;
  /** Called with true when the phone gets a connection and false when it loses it. */
  subscribe(listener: (online: boolean) => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Offline identity and per-user lifecycle
// ---------------------------------------------------------------------------------------------

/**
 * The last signed-in user, so the app can open offline with their cache and queue when the
 * server cannot be reached at start. Stored next to the tokens (SecureStore); removed at sign-out.
 */
export interface OfflineIdentityStore {
  save(user: AuthUser): Promise<void>;
  load(): Promise<AuthUser | null>;
  clear(): Promise<void>;
}

/** What sign-out must decide when the queue is not empty. */
export type SignOutChoice =
  /** Run a sync first and sign out only when the queue is empty. */
  | 'syncFirst'
  /** Sign out, keep this user's queue and photos on the phone for their next sign-in. */
  | 'keepForLater'
  /** Delete this user's queue, photos and cache, then sign out. */
  | 'discard';

/** Opens and closes the per-user offline layer. One user's layer is open at a time. */
export interface OfflineSession {
  readonly userId: string;
  readonly store: LocalStore;
  readonly queue: WriteQueue;
  readonly photos: LocalPhotoStore;
  readonly engine: SyncEngine;
  close(): Promise<void>;
}

export interface OfflineSessionFactory {
  /** Opens (creating if needed) the database and photo folder of `userId`. */
  open(userId: string): Promise<OfflineSession>;
  /**
   * Sign-out cleanup of a user: with an empty queue, deletes their database and photos; with
   * items left, `keepForLater` deletes only the cache and `discard` deletes everything.
   */
  signOutCleanup(userId: string, choice: SignOutChoice): Promise<void>;
  /**
   * Start-up sweep: deletes the databases and photo folders of users who signed out more than
   * `KEPT_QUEUE_MAX_DAYS` ago (they were warned at sign-out). Never touches the open user.
   */
  sweepAbandoned(now: Date): Promise<string[]>;
}

/** How long a signed-out user's kept queue stays on the phone (ADR-0008). */
export const KEPT_QUEUE_MAX_DAYS = 30;
