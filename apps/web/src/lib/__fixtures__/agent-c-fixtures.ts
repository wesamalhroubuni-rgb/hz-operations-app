import type { ApiFailure, ApiResult, Task, UserFull } from '@ops/shared';

// Test fixtures of the tasks / people / structure screens (agent C). Imported by tests only.

export const IDS = {
  org: '0190f3a2-7c1e-7000-8000-0000000000aa',
  me: '0190f3a2-7c1e-7000-8000-000000000001',
  worker: '0190f3a2-7c1e-7000-8000-000000000002',
  worker2: '0190f3a2-7c1e-7000-8000-000000000003',
  site: '0190f3a2-7c1e-7000-8000-000000000010',
  team: '0190f3a2-7c1e-7000-8000-000000000020',
  task: '0190f3a2-7c1e-7000-8000-000000000100',
} as const;

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: IDS.task,
    organizationId: IDS.org,
    title: 'Fix the gate',
    description: null,
    status: 'todo',
    priority: 'normal',
    siteId: null,
    teamId: null,
    createdById: IDS.me,
    assigneeIds: [],
    dueAt: null,
    completedAt: null,
    statusReason: null,
    version: 3,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

export function makeUserFull(overrides: Partial<UserFull> = {}): UserFull {
  return {
    profile: 'full',
    id: IDS.worker,
    displayName: 'Ayşe Worker',
    roles: ['worker'],
    email: 'ayse@example.test',
    phone: null,
    organizationId: IDS.org,
    username: null,
    memberships: [],
    activated: true,
    locale: 'en',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

export function ok<Data>(data: Data): ApiResult<Data> {
  return { ok: true, status: 200, data };
}

export function httpFailure(status: number, code: string, message = 'refused'): ApiResult<never> {
  const failure = {
    kind: 'http',
    status,
    message,
    error: { code, message },
  } as unknown as ApiFailure;
  return { ok: false, failure };
}
