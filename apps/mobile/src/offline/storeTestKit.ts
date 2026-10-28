// Fixtures for the tests of the offline store, queue, photo store and session (not shipped code:
// only `*.test.ts` files import it).
import type {
  AppNotification,
  CreateWorkLogInput,
  OrganizationSummary,
  SyncPullResponse,
  Task,
  WorkLog,
} from '@ops/shared';

import type { LocalPhoto } from '../storage/localPhoto';
import { createMemoryDatabase } from './db';
import { createLocalStore } from './localStore';
import { createLocalPhotoStore, createMemoryPhotoFiles } from './photoStore';
import { createWriteQueue } from './writeQueue';

export const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ORG = '99999999-9999-4999-8999-999999999999';
export const T0 = new Date('2026-10-27T10:00:00.000Z');

/** Deterministic UUID-shaped ids: id(1) = 00000000-0000-4000-8000-000000000001. */
export function idSequence(prefix = '0') {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix.repeat(8)}-0000-4000-8000-${String(next).padStart(12, '0')}`;
  };
}

export function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

export function workLog(overrides: Partial<WorkLog> = {}): WorkLog {
  return {
    id: 'log-1',
    organizationId: ORG,
    clientId: 'client-1',
    authorId: USER_A,
    occurredAt: T0.toISOString(),
    taskId: null,
    siteId: null,
    teamId: null,
    logTypeId: null,
    logTypeVersion: null,
    text: 'Pump checked',
    customFields: {},
    location: null,
    status: 'submitted',
    review: null,
    source: 'manual',
    aiMetadata: null,
    version: 1,
    submittedOffline: false,
    deviceCreatedAt: null,
    clockSkewSeconds: null,
    clockSkewFlagged: false,
    declaredAttachmentClientIds: [],
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    organizationId: ORG,
    title: 'Check the pump',
    description: null,
    status: 'todo',
    priority: 'normal',
    siteId: null,
    teamId: null,
    createdById: USER_B,
    assigneeIds: [USER_A],
    dueAt: null,
    completedAt: null,
    statusReason: null,
    version: 1,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

export function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n-1',
    type: 'task.assigned',
    title: 'New task',
    body: 'A task was assigned to you',
    data: {},
    readAt: null,
    createdAt: T0.toISOString(),
    ...overrides,
  };
}

export const ORGANIZATION: OrganizationSummary = {
  view: 'summary',
  id: ORG,
  name: 'Demo',
  slug: 'demo',
  workLogEditWindowHours: 24,
  offlineMaxBackdateDays: 7,
};

type PullParts = Partial<{
  [Name in 'tasks' | 'logTypes' | 'sites' | 'teams' | 'workLogs' | 'notifications']: {
    upserts: SyncPullResponse[Name]['upserts'];
    ids?: string[];
  };
}>;

/** A pull; `ids` default to the upserts' ids. */
export function pull(parts: PullParts = {}, full = true, cursor = 'cursor-1'): SyncPullResponse {
  const part = <Item extends { id: string }>(value?: { upserts: Item[]; ids?: string[] }) => ({
    upserts: value?.upserts ?? [],
    ids: value?.ids ?? (value?.upserts ?? []).map((item) => item.id),
  });
  return {
    serverTime: T0.toISOString(),
    cursor,
    full,
    organization: ORGANIZATION,
    tasks: part(parts.tasks),
    logTypes: part(parts.logTypes),
    sites: part(parts.sites),
    teams: part(parts.teams),
    workLogs: part(parts.workLogs),
    notifications: part(parts.notifications),
  };
}

export function createBody(overrides: Partial<CreateWorkLogInput> = {}): CreateWorkLogInput {
  return {
    clientId: 'client-new',
    occurredAt: T0.toISOString(),
    text: 'New offline log',
    customFields: {},
    status: 'submitted',
    source: 'manual',
    ...overrides,
  };
}

export function photo(localId: string, sizeBytes = 1000): LocalPhoto {
  return {
    localId,
    uri: `file:///documents/pending-photos/${localId}.jpg`,
    fileName: `${localId}.jpg`,
    mimeType: 'image/jpeg',
    width: 1600,
    height: 1200,
    sizeBytes,
  };
}

/** One user's offline layer over in-memory adapters. */
export function memoryLayer(userId = USER_A, options: { limitBytes?: number } = {}) {
  const db = createMemoryDatabase();
  const files = createMemoryPhotoFiles();
  const newId = idSequence();
  const store = createLocalStore(db, userId);
  const photos = createLocalPhotoStore(files, userId, options.limitBytes);
  const queue = createWriteQueue({
    db,
    userId,
    newId,
    deletePhoto: (localId) => photos.delete(localId),
    clearPhotos: () => photos.clear(),
    lookupWorkLog: (clientId) => store.getWorkLogByClientId(clientId),
  });
  return { db, files, newId, store, photos, queue };
}
