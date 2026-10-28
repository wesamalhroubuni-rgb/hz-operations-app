import type { TranslateParams } from '../i18n/translate';
import type { TranslationKey } from '../i18n';
import type {
  PhotoStorageUsage,
  QueuedMutationKind,
  QueueItem,
  QueueItemError,
  SyncStatus,
} from '../offline/types';

// Pure presentation logic of the sync UI: what the indicator, the banners, the sync screen and
// the sign-out dialog say and offer. Returns catalogue keys (with parameters), never English, so
// it is tested without React and every sentence stays in `src/i18n/en.ts`.

export interface Text {
  key: TranslationKey;
  params?: TranslateParams;
  /** Parameters that are themselves catalogue keys (translated first). */
  nested?: Record<string, TranslationKey>;
}

export type SyncTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export interface StatusPresentation {
  text: Text;
  tone: SyncTone;
  icon:
    | 'cloud-done-outline'
    | 'sync-outline'
    | 'cloud-upload-outline'
    | 'alert-circle-outline'
    | 'cloud-offline-outline'
    | 'log-in-outline';
}

/** The small indicator: one short label, a tone and an icon per status. */
export function statusPresentation(status: SyncStatus): StatusPresentation {
  switch (status.kind) {
    case 'synced':
      return { text: { key: 'sync.status.synced' }, tone: 'success', icon: 'cloud-done-outline' };
    case 'syncing':
      return { text: { key: 'sync.status.syncing' }, tone: 'info', icon: 'sync-outline' };
    case 'pending':
      return {
        text: { key: 'sync.status.pending', params: { count: status.pending } },
        tone: 'warning',
        icon: 'cloud-upload-outline',
      };
    case 'failed':
      return {
        text: { key: 'sync.status.failed', params: { count: status.failed } },
        tone: 'danger',
        icon: 'alert-circle-outline',
      };
    case 'offline': {
      const waiting = status.pending + status.failed;
      return {
        text:
          waiting > 0
            ? { key: 'sync.status.offlineWaiting', params: { count: waiting } }
            : { key: 'sync.status.offline' },
        tone: 'neutral',
        icon: 'cloud-offline-outline',
      };
    }
    case 'needsSignIn':
      return { text: { key: 'sync.status.needsSignIn' }, tone: 'danger', icon: 'log-in-outline' };
  }
}

/**
 * The banner above Home, Tasks and Logs. Null: nothing to say. `openedOffline`: the app started
 * with the stored identity because the server could not be reached (`useAuth().offline`).
 */
export function bannerFor(
  status: SyncStatus | null,
  lastRefreshedLabel: string | null,
  openedOffline = false,
): { text: Text; tone: 'notice' | 'error'; signIn: boolean } | null {
  const openedOfflineBanner = openedOffline
    ? { text: { key: 'sync.offlineStart' } as Text, tone: 'notice' as const, signIn: false }
    : null;
  if (status === null) return openedOfflineBanner;
  if (status.kind === 'needsSignIn') {
    const waiting = status.pending + status.failed;
    return {
      text:
        waiting > 0
          ? { key: 'sync.needsSignInBanner', params: { count: waiting } }
          : { key: 'sync.needsSignInBannerEmpty' },
      tone: 'error',
      signIn: true,
    };
  }
  if (status.kind === 'offline') {
    return {
      text:
        lastRefreshedLabel === null
          ? { key: 'sync.offlineBanner' }
          : { key: 'sync.offlineBannerRefreshed', params: { time: lastRefreshedLabel } },
      tone: 'notice',
      signIn: false,
    };
  }
  return openedOfflineBanner;
}

/** "Last refreshed" uses the time alone for today, the date and time otherwise. */
export function refreshedWhen(iso: string | null, now: Date): 'never' | 'today' | 'earlier' {
  if (iso === null) return 'never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'never';
  return at.toDateString() === now.toDateString() ? 'today' : 'earlier';
}

// ---------------------------------------------------------------------------------------------
// Queue items
// ---------------------------------------------------------------------------------------------

/** The reason of a failed item, in the worker's words. */
export function reasonText(item: Pick<QueueItem, 'mutation' | 'lastError'>): Text | null {
  const error: QueueItemError | null = item.lastError;
  if (error === null) return null;
  // ADR-0008: a worker unassigned from a task no longer sees it: the server says 404.
  if (error.code === 'not_found' && item.mutation.kind === 'changeTaskStatus') {
    return { key: 'sync.reasons.taskNoLongerAssigned' };
  }
  return { key: `sync.reasons.${error.code}` };
}

export function itemTitle(item: Pick<QueueItem, 'mutation'>): Text {
  const mutation = item.mutation;
  if (mutation.kind === 'changeTaskStatus') {
    return {
      key: 'sync.kinds.changeTaskStatus',
      nested: { status: `tasks.status.${mutation.body.status}` },
    };
  }
  return { key: `sync.kinds.${mutation.kind}` };
}

/** A short line of the worker's content, to recognise the item. Null when there is none. */
export function itemSummary(item: Pick<QueueItem, 'mutation'>): string | null {
  const mutation = item.mutation;
  switch (mutation.kind) {
    case 'createWorkLog':
    case 'updateWorkLog': {
      const text = mutation.body.text;
      return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
    }
    case 'uploadAttachment':
      return mutation.photo.fileName;
    default:
      return null;
  }
}

export interface ItemActions {
  retry: boolean;
  view: boolean;
  copy: boolean;
  resubmit: boolean;
  discard: boolean;
}

const LOG_CONTENT_KINDS: readonly QueuedMutationKind[] = ['createWorkLog', 'updateWorkLog'];

/**
 * What the worker may do with an item. Waiting items are left alone (they are sent on their
 * own); a failed one can be retried or discarded; a refused one can also be viewed and copied,
 * and a refused log (create or edit) sent again as a new log.
 */
export function itemActions(item: Pick<QueueItem, 'mutation' | 'state'>): ItemActions {
  const failed = item.state === 'failed_permanent' || item.state === 'failed_retryable';
  const refused = item.state === 'failed_permanent';
  const hasText = item.mutation.kind !== 'uploadAttachment';
  return {
    retry: failed,
    view: refused && hasText,
    copy: refused && hasText,
    resubmit: refused && LOG_CONTENT_KINDS.includes(item.mutation.kind),
    discard: failed,
  };
}

/** The sync screen's two lists: refused first (they need the worker), then the rest. */
export function groupItems(items: readonly QueueItem[]): {
  failed: QueueItem[];
  waiting: QueueItem[];
} {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  return {
    failed: sorted.filter((item) => item.state === 'failed_permanent'),
    waiting: sorted.filter((item) => item.state !== 'failed_permanent' && item.state !== 'done'),
  };
}

// ---------------------------------------------------------------------------------------------
// Per-log state
// ---------------------------------------------------------------------------------------------

export type LogSyncState = 'pending' | 'failed' | 'synced';

const WORK_LOG_PREFIX = 'workLog:';

/** The sync state of every log with queued items, by the log's clientId. */
export function logSyncStates(items: readonly QueueItem[]): Map<string, LogSyncState> {
  const states = new Map<string, LogSyncState>();
  for (const item of items) {
    if (!item.recordKey.startsWith(WORK_LOG_PREFIX) || item.state === 'done') continue;
    const clientId = item.recordKey.slice(WORK_LOG_PREFIX.length);
    if (item.state === 'failed_permanent') states.set(clientId, 'failed');
    else if (!states.has(clientId)) states.set(clientId, 'pending');
  }
  return states;
}

export function logSyncState(
  states: ReadonlyMap<string, LogSyncState>,
  clientId: string | null | undefined,
): LogSyncState {
  return (clientId ? states.get(clientId) : undefined) ?? 'synced';
}

/** The first refused item of a log (its reason is shown on the log's detail). */
export function refusedItemOfLog(
  items: readonly QueueItem[],
  clientId: string | null | undefined,
): QueueItem | null {
  if (!clientId) return null;
  return (
    items.find(
      (item) =>
        item.recordKey === `${WORK_LOG_PREFIX}${clientId}` && item.state === 'failed_permanent',
    ) ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// Photo storage and sign-out
// ---------------------------------------------------------------------------------------------

function megabytes(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}

/** The warning at 80% and the block at 100% of the local photo storage. */
export function photoStorageNotice(
  usage: PhotoStorageUsage | null,
): { text: Text; tone: 'notice' | 'error'; usedMb: string; limitMb: string } | null {
  if (usage === null || usage.level === 'ok') return null;
  const usedMb = megabytes(usage.usedBytes);
  const limitMb = megabytes(usage.limitBytes);
  return usage.level === 'full'
    ? { text: { key: 'sync.photoStorage.full' }, tone: 'error', usedMb, limitMb }
    : { text: { key: 'sync.photoStorage.warning' }, tone: 'notice', usedMb, limitMb };
}

/** Sign-out asks first only when something is still on the phone. */
export function signOutStep(pendingCount: number): 'signOutNow' | 'ask' {
  return pendingCount > 0 ? 'ask' : 'signOutNow';
}

/** After "Sync first": sign out once everything is sent, else keep the dialog open. */
export function afterSyncFirst(pendingCount: number): 'signOutNow' | 'stillPending' {
  return pendingCount > 0 ? 'stillPending' : 'signOutNow';
}

// ---------------------------------------------------------------------------------------------
// Sign-in screen, empty cache, dropped links
// ---------------------------------------------------------------------------------------------

/** The sign-in screen's line for a user whose session ended with changes still on the phone. */
export function signInWaitingText(name: string, pending: number): Text {
  return pending > 0
    ? { key: 'sync.needsSignInLogin', params: { count: pending, name } }
    : { key: 'sync.needsSignInLoginEmpty', params: { name } };
}

/**
 * How a list explains a failed read: a network failure before the first successful pull means
 * nothing was downloaded yet (a friendly empty state); anything else is an error.
 */
export function readFailureView(
  kind: string,
  lastRefreshedAt: string | null,
): 'notDownloaded' | 'error' {
  return kind === 'network' && lastRefreshedAt === null ? 'notDownloaded' : 'error';
}

export type DroppedField = 'taskId' | 'siteId' | 'teamId';

/** The catalogue keys naming each dropped link ("the task", "the site", ...), in order. */
export function droppedReferenceKeys(fields: readonly DroppedField[]): TranslationKey[] {
  return (['taskId', 'siteId', 'teamId'] as const)
    .filter((field) => fields.includes(field))
    .map((field) => `sync.droppedReferences.${field}` as const);
}
