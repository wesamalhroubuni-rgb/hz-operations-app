import { API_ERROR_CODES } from '@ops/shared';

import { en } from '../i18n/en';
import { createTranslator, type CatalogueTree } from '../i18n/translate';
import type { QueuedMutation, QueueItem, QueueItemError, QueueItemState } from '../offline/types';
import {
  afterSyncFirst,
  bannerFor,
  droppedReferenceKeys,
  groupItems,
  itemActions,
  itemSummary,
  itemTitle,
  logSyncState,
  logSyncStates,
  photoStorageNotice,
  readFailureView,
  reasonText,
  refreshedWhen,
  refusedItemOfLog,
  signInWaitingText,
  signOutStep,
  statusPresentation,
  type Text,
} from './sync';

const translator = createTranslator<string>(
  'en',
  en as unknown as CatalogueTree,
  en as unknown as CatalogueTree,
);
function render(text: Text | null): string {
  if (text === null) return '';
  const nested: Record<string, string> = {};
  for (const [name, key] of Object.entries(text.nested ?? {})) nested[name] = translator.t(key);
  return translator.t(text.key, { ...text.params, ...nested });
}

let seq = 0;
function item(
  mutation: QueuedMutation,
  state: QueueItemState = 'pending',
  lastError: QueueItemError | null = null,
): QueueItem {
  seq += 1;
  const recordKey =
    mutation.kind === 'createWorkLog'
      ? `workLog:${mutation.body.clientId}`
      : mutation.kind === 'changeTaskStatus'
        ? `task:${mutation.taskId}`
        : `workLog:${mutation.workLogClientId}`;
  return {
    id: `item-${seq}`,
    seq,
    recordKey,
    mutation,
    state,
    idempotencyKey: `key-${seq}`,
    attempts: 0,
    nextAttemptAt: null,
    lastError,
    createdAt: '2026-10-27T08:00:00.000Z',
    updatedAt: '2026-10-27T08:00:00.000Z',
  };
}

const create = (clientId: string, text = 'Fixed the pump'): QueuedMutation => ({
  kind: 'createWorkLog',
  body: { clientId, text, occurredAt: '2026-10-27T07:00:00.000Z' } as never,
});
const update = (clientId: string): QueuedMutation => ({
  kind: 'updateWorkLog',
  workLogClientId: clientId,
  body: { text: 'Changed', expectedVersion: 2 },
});
const taskStatus: QueuedMutation = {
  kind: 'changeTaskStatus',
  taskId: 'task-1',
  body: { status: 'done', expectedVersion: 1 },
};
const photo: QueuedMutation = {
  kind: 'uploadAttachment',
  workLogClientId: 'log-a',
  workLogId: null,
  attachmentClientId: 'photo-a',
  photo: {
    localId: 'p1',
    uri: 'file:///p1.jpg',
    fileName: 'p1.jpg',
    mimeType: 'image/jpeg',
    width: 10,
    height: 10,
    sizeBytes: 10,
  },
  checkpoint: { attachmentId: null, stored: false },
};
const error = (code: QueueItemError['code']): QueueItemError => ({
  code,
  message: code,
  status: null,
});

describe('status text', () => {
  it('says each status in a few words', () => {
    expect(render(statusPresentation({ kind: 'synced', lastRefreshedAt: null }).text)).toBe(
      'All sent',
    );
    expect(render(statusPresentation({ kind: 'syncing', pending: 2 }).text)).toBe('Sending…');
    expect(render(statusPresentation({ kind: 'pending', pending: 3 }).text)).toBe('3 waiting');
    expect(render(statusPresentation({ kind: 'failed', failed: 1, pending: 0 }).text)).toBe(
      '1 not accepted',
    );
    expect(render(statusPresentation({ kind: 'offline', pending: 0, failed: 0 }).text)).toBe(
      'Offline',
    );
    expect(render(statusPresentation({ kind: 'offline', pending: 2, failed: 1 }).text)).toBe(
      'Offline, 3 waiting',
    );
    expect(render(statusPresentation({ kind: 'needsSignIn', pending: 1, failed: 0 }).text)).toBe(
      'Sign in again',
    );
  });

  it('uses a tone that never relies on colour alone (each has text)', () => {
    expect(statusPresentation({ kind: 'failed', failed: 1, pending: 0 }).tone).toBe('danger');
    expect(statusPresentation({ kind: 'pending', pending: 1 }).tone).toBe('warning');
  });
});

describe('banners', () => {
  it('shows "offline" with the last refreshed time', () => {
    const banner = bannerFor({ kind: 'offline', pending: 0, failed: 0 }, '14:05');
    expect(render(banner?.text ?? null)).toContain('Showing data from 14:05');
    expect(banner?.signIn).toBe(false);
  });

  it('asks to sign in again, saying how many changes wait', () => {
    const banner = bannerFor({ kind: 'needsSignIn', pending: 2, failed: 1 }, null);
    expect(banner).toMatchObject({ tone: 'error', signIn: true });
    expect(render(banner?.text ?? null)).toContain('send the 3 changes');
  });

  it('shows nothing when online', () => {
    expect(bannerFor({ kind: 'pending', pending: 1 }, null)).toBeNull();
    expect(bannerFor(null, null)).toBeNull();
  });

  it('tells "today" from earlier for the last refreshed time', () => {
    const now = new Date(2026, 9, 27, 15, 0);
    expect(refreshedWhen(null, now)).toBe('never');
    expect(refreshedWhen(new Date(2026, 9, 27, 9, 0).toISOString(), now)).toBe('today');
    expect(refreshedWhen(new Date(2026, 9, 25, 9, 0).toISOString(), now)).toBe('earlier');
  });
});

describe('queue items', () => {
  it('has a message for every API error code and every local failure code', () => {
    const codes = [...API_ERROR_CODES, 'network', 'timeout', 'invalid_response', 'photo_missing'];
    for (const code of codes) {
      const text = render(reasonText(item(create('a'), 'failed_permanent', error(code as never))));
      expect(text).not.toMatch(/^sync\./);
      expect(text.length).toBeGreaterThan(10);
    }
  });

  it('maps the conflict codes to the right sentence', () => {
    const say = (code: QueueItemError['code'], mutation: QueuedMutation = update('a')) =>
      render(reasonText(item(mutation, 'failed_permanent', error(code))));
    expect(say('already_reviewed')).toContain('approved');
    expect(say('version_conflict')).toContain('Someone else changed this');
    expect(say('edit_window_closed')).toContain('time to edit');
    expect(say('task_cancelled', taskStatus)).toContain('cancelled');
    expect(say('occurred_at_out_of_range', create('a'))).toContain('too far in the past');
    // A worker unassigned from a task no longer sees it: 404 means "no longer assigned".
    expect(say('not_found', taskStatus)).toBe('This task is no longer assigned to you.');
    expect(say('not_found', update('a'))).toContain('no longer exists');
  });

  it('has no reason before a failure', () => {
    expect(reasonText(item(create('a')))).toBeNull();
  });

  it('names the kind of change, with the task status', () => {
    expect(render(itemTitle(item(create('a'))))).toBe('New log');
    expect(render(itemTitle(item(taskStatus)))).toBe('Task status: Done');
    expect(render(itemTitle(item(photo)))).toBe('Photo');
    expect(itemSummary(item(create('a', '  Pump  ')))).toBe('Pump');
    expect(itemSummary(item(photo))).toBe('p1.jpg');
    expect(itemSummary(item(taskStatus))).toBeNull();
  });

  it('offers retry and discard on failures, view/copy/resubmit on refused logs only', () => {
    expect(itemActions(item(create('a')))).toEqual({
      retry: false,
      view: false,
      copy: false,
      resubmit: false,
      discard: false,
    });
    expect(itemActions(item(create('a'), 'failed_retryable'))).toEqual({
      retry: true,
      view: false,
      copy: false,
      resubmit: false,
      discard: true,
    });
    expect(itemActions(item(update('a'), 'failed_permanent'))).toEqual({
      retry: true,
      view: true,
      copy: true,
      resubmit: true,
      discard: true,
    });
    expect(itemActions(item(taskStatus, 'failed_permanent'))).toMatchObject({
      resubmit: false,
      copy: true,
    });
    expect(itemActions(item(photo, 'failed_permanent'))).toMatchObject({
      view: false,
      copy: false,
      resubmit: false,
      discard: true,
    });
  });

  it('lists refused items first, then the waiting ones in order', () => {
    const a = item(create('a'));
    const b = item(update('b'), 'failed_permanent', error('already_reviewed'));
    const c = item(taskStatus, 'failed_retryable', error('network'));
    expect(groupItems([c, b, a])).toEqual({ failed: [b], waiting: [a, c] });
  });
});

describe('per-log sync state', () => {
  it('is failed when any item of the log was refused, pending while items wait, else synced', () => {
    const items = [
      item(create('a')),
      item(update('b')),
      item(update('b'), 'failed_permanent', error('version_conflict')),
      item(taskStatus),
    ];
    const states = logSyncStates(items);
    expect(logSyncState(states, 'a')).toBe('pending');
    expect(logSyncState(states, 'b')).toBe('failed');
    expect(logSyncState(states, 'c')).toBe('synced');
    expect(logSyncState(states, null)).toBe('synced');
    expect(refusedItemOfLog(items, 'b')).toBe(items[2]);
    expect(refusedItemOfLog(items, 'a')).toBeNull();
  });
});

describe('photo storage notice', () => {
  const mb = 1024 * 1024;
  it('warns at 80% and blocks at 100%', () => {
    expect(
      photoStorageNotice({ usedBytes: 10 * mb, limitBytes: 500 * mb, level: 'ok' }),
    ).toBeNull();
    expect(
      photoStorageNotice({ usedBytes: 410 * mb, limitBytes: 500 * mb, level: 'warning' }),
    ).toMatchObject({ tone: 'notice', usedMb: '410', limitMb: '500' });
    const full = photoStorageNotice({ usedBytes: 500 * mb, limitBytes: 500 * mb, level: 'full' });
    expect(full?.tone).toBe('error');
    expect(render(full?.text ?? null)).toContain('cannot be added');
  });
});

describe('sign-out choice', () => {
  it('asks only when changes are still on the phone', () => {
    expect(signOutStep(0)).toBe('signOutNow');
    expect(signOutStep(2)).toBe('ask');
  });

  it('signs out after "Sync first" only when everything was sent', () => {
    expect(afterSyncFirst(0)).toBe('signOutNow');
    expect(afterSyncFirst(1)).toBe('stillPending');
    expect(translator.t('sync.signOut.stillPending', { count: 1 })).toContain('1 change');
  });
});

describe('phase 5 notices', () => {
  it('tells an app opened offline, unless a more specific banner applies', () => {
    expect(render(bannerFor(null, null, true)?.text ?? null)).toContain('without a connection');
    expect(render(bannerFor({ kind: 'pending', pending: 1 }, null, true)?.text ?? null)).toContain(
      'without a connection',
    );
    expect(bannerFor({ kind: 'offline', pending: 0, failed: 0 }, '9:00', true)?.text.key).toBe(
      'sync.offlineBannerRefreshed',
    );
    expect(bannerFor({ kind: 'needsSignIn', pending: 0, failed: 0 }, null, true)?.signIn).toBe(
      true,
    );
  });

  it('says on the sign-in screen how many changes wait for whom', () => {
    expect(render(signInWaitingText('Deniz', 3))).toBe(
      '3 changes wait on this phone for Deniz. Sign in again as Deniz to send them.',
    );
    expect(render(signInWaitingText('Deniz', 1))).toContain('1 change waits');
    expect(render(signInWaitingText('Deniz', 0))).toBe(
      'The session of Deniz has ended. Sign in again.',
    );
  });

  it('shows "nothing downloaded yet" for a network failure before the first pull only', () => {
    expect(readFailureView('network', null)).toBe('notDownloaded');
    expect(readFailureView('network', '2026-10-27T08:00:00.000Z')).toBe('error');
    expect(readFailureView('server', null)).toBe('error');
    expect(translator.t('sync.notDownloaded')).toContain('Connect to the internet once');
  });

  it('names the dropped links in a fixed order', () => {
    expect(droppedReferenceKeys(['teamId', 'taskId'])).toEqual([
      'sync.droppedReferences.taskId',
      'sync.droppedReferences.teamId',
    ]);
    expect(droppedReferenceKeys([])).toEqual([]);
  });

  it('has a sentence for a form refused because the photo storage is full', () => {
    expect(translator.t('logForm.errors.photoStorageFull')).toContain('do not fit');
  });
});
