import {
  changeTaskStatusSchema,
  createTaskSchema,
  OPEN_TASK_STATUSES,
  TASK_STATUSES,
  updateTaskSchema,
  zonedParts,
  zonedTimeToInstant,
  type ChangeTaskStatus,
  type CreateTaskInput,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type UpdateTask,
  type ApiResult,
} from '@ops/shared';

import { ApiCallError, failureOf } from './api/errors';
import type { Capabilities } from './permissions';

/**
 * Tasks screen logic (Phase 6, agent C): grouping for the board, the create / edit / status
 * request bodies, which actions to offer, and how a refused write is explained. Pure, so tested.
 * UX only: the API checks scope, references and assignees on every request.
 */

// ---- Board ------------------------------------------------------------------------------

/** The tasks of a page grouped by status, every status present, in `TASK_STATUSES` order. */
export function groupTasksByStatus(tasks: readonly Task[]): Record<TaskStatus, Task[]> {
  const groups = Object.fromEntries(
    TASK_STATUSES.map((status) => [status, [] as Task[]]),
  ) as Record<TaskStatus, Task[]>;
  for (const task of tasks) {
    groups[task.status].push(task);
  }
  return groups;
}

export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return (OPEN_TASK_STATUSES as readonly string[]).includes(task.status);
}

/** Open and due before `now` (the server's `overdue` filter uses the same rule). */
export function isOverdue(task: Pick<Task, 'status' | 'dueAt'>, now: Date): boolean {
  return isOpenTask(task) && task.dueAt !== null && Date.parse(task.dueAt) < now.getTime();
}

// ---- Actions ----------------------------------------------------------------------------

export interface TaskActions {
  edit: boolean;
  assign: boolean;
  changeStatus: boolean;
  cancel: boolean;
  archive: boolean;
}

/**
 * What the dashboard offers on a task. Supervisors, managers and admins manage tasks (a
 * supervisor only within scope, which the server checks: a refusal is shown as an error).
 * Nothing changes on an archived task.
 */
export function taskActions(
  capabilities: Capabilities,
  task: Pick<Task, 'status' | 'archivedAt'>,
): TaskActions {
  const manage = capabilities.manageTasks && task.archivedAt === null;
  return {
    edit: manage,
    assign: manage,
    changeStatus: manage,
    cancel: manage && task.status !== 'cancelled',
    archive: manage,
  };
}

// ---- Form <-> request bodies ------------------------------------------------------------

export interface TaskFormState {
  title: string;
  description: string;
  priority: TaskPriority;
  siteId: string;
  teamId: string;
  /** `YYYY-MM-DDTHH:MM` in the ORGANIZATION's time zone (a `datetime-local` input), or ''. */
  due: string;
  assigneeIds: string[];
}

export function emptyTaskForm(): TaskFormState {
  return {
    title: '',
    description: '',
    priority: 'normal',
    siteId: '',
    teamId: '',
    due: '',
    assigneeIds: [],
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** An instant as a `datetime-local` value in the organization's zone ('' for null). */
export function isoToDueInput(iso: string | null, timeZone: string): string {
  if (iso === null || Number.isNaN(Date.parse(iso))) {
    return '';
  }
  const p = zonedParts(iso, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** A `datetime-local` value read as wall time in the organization's zone; null when empty. */
export function dueInputToIso(value: string, timeZone: string): string | null | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(trimmed);
  if (!match) {
    return 'invalid';
  }
  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return zonedTimeToInstant({ year, month, day, hour, minute, second: 0 }, timeZone).toISOString();
}

export function taskFormFrom(task: Task, timeZone: string): TaskFormState {
  return {
    title: task.title,
    description: task.description ?? '',
    priority: task.priority,
    siteId: task.siteId ?? '',
    teamId: task.teamId ?? '',
    due: isoToDueInput(task.dueAt, timeZone),
    assigneeIds: [...task.assigneeIds],
  };
}

/** Problems keyed by form field (`title`, `due`, ...). Values are the API's own sentences. */
export type FormErrors = Record<string, string>;

export type BodyResult<Body> = { ok: true; body: Body } | { ok: false; errors: FormErrors };

function issuesToErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FormErrors {
  const errors: FormErrors = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : 'form';
    const field = key === 'dueAt' ? 'due' : key;
    errors[field] ??= issue.message;
  }
  return errors;
}

/** `POST /tasks`. Empty optional fields are left out (the server's defaults apply). */
export function createTaskBody(
  form: TaskFormState,
  timeZone: string,
  invalidDueMessage: string,
): BodyResult<CreateTaskInput> {
  const dueAt = dueInputToIso(form.due, timeZone);
  if (dueAt === 'invalid') {
    return { ok: false, errors: { due: invalidDueMessage } };
  }
  const body: CreateTaskInput = {
    title: form.title.trim(),
    priority: form.priority,
    assigneeIds: [...form.assigneeIds],
    ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
    ...(form.siteId === '' ? {} : { siteId: form.siteId }),
    ...(form.teamId === '' ? {} : { teamId: form.teamId }),
    ...(dueAt === null ? {} : { dueAt }),
  };
  const parsed = createTaskSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

export interface TaskEdit {
  /** `PATCH /tasks/:id`, or null when no field changed. */
  update: UpdateTask | null;
  /** `PUT /tasks/:id/assignees`, or null when the assignees did not change. */
  assigneeIds: string[] | null;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/**
 * The changes of an edit, split like the API: fields through `PATCH /tasks/:id` (only those that
 * changed; `null` clears), assignees through `PUT /tasks/:id/assignees`.
 */
export function editTaskBodies(
  task: Task,
  form: TaskFormState,
  timeZone: string,
  invalidDueMessage: string,
): BodyResult<TaskEdit> {
  const dueAt = dueInputToIso(form.due, timeZone);
  if (dueAt === 'invalid') {
    return { ok: false, errors: { due: invalidDueMessage } };
  }
  const update: UpdateTask = {};
  const title = form.title.trim();
  if (title !== task.title) update.title = title;
  const description = form.description.trim() === '' ? null : form.description.trim();
  if (description !== task.description) update.description = description;
  if (form.priority !== task.priority) update.priority = form.priority;
  const siteId = form.siteId === '' ? null : form.siteId;
  if (siteId !== task.siteId) update.siteId = siteId;
  const teamId = form.teamId === '' ? null : form.teamId;
  if (teamId !== task.teamId) update.teamId = teamId;
  // Compare instants at minute precision: the input has no seconds.
  const currentDue = isoToDueInput(task.dueAt, timeZone);
  if (form.due.trim() !== currentDue) update.dueAt = dueAt;

  const hasUpdate = Object.keys(update).length > 0;
  if (hasUpdate) {
    const parsed = updateTaskSchema.safeParse(update);
    if (!parsed.success) {
      return { ok: false, errors: issuesToErrors(parsed.error.issues) };
    }
  }
  const assigneesChanged = !sameIds(task.assigneeIds, form.assigneeIds);
  return {
    ok: true,
    body: {
      update: hasUpdate ? update : null,
      assigneeIds: assigneesChanged ? [...form.assigneeIds] : null,
    },
  };
}

/** Statuses that need a reason in the dashboard: `blocked` (API rule) and `cancelled` (ours). */
export function statusNeedsReason(status: TaskStatus): boolean {
  return status === 'blocked' || status === 'cancelled';
}

/**
 * `PATCH /tasks/:id/status`, always with `expectedVersion` (ADR-0008): when somebody changed the
 * task since it was loaded, the API answers 409 `version_conflict` instead of overwriting.
 */
export function statusChangeBody(
  task: Pick<Task, 'version'>,
  status: TaskStatus,
  reason: string,
): BodyResult<ChangeTaskStatus> {
  const trimmed = reason.trim();
  const body: ChangeTaskStatus = {
    expectedVersion: task.version,
    status,
    ...(trimmed === '' ? {} : { reason: trimmed }),
  };
  if (statusNeedsReason(status) && trimmed === '') {
    return { ok: false, errors: { reason: 'required' } };
  }
  const parsed = changeTaskStatusSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

// ---- Refusals ---------------------------------------------------------------------------

export type TaskWriteRefusal =
  | 'version_conflict'
  | 'task_cancelled'
  | 'record_archived'
  | 'forbidden'
  | 'not_found'
  | 'invalid_reference'
  | 'other';

/** Why a task write failed, for a specific message (and, for a conflict, a reload). */
export function taskWriteRefusal(error: unknown): TaskWriteRefusal {
  const failure = failureOf(error);
  if (failure === null || failure.kind !== 'http') {
    return 'other';
  }
  switch (failure.error.code) {
    case 'version_conflict':
      return 'version_conflict';
    case 'task_cancelled':
      return 'task_cancelled';
    case 'record_archived':
      return 'record_archived';
    default:
      break;
  }
  if (failure.status === 403) return 'forbidden';
  if (failure.status === 404) return 'not_found';
  if (failure.status === 422) return 'invalid_reference';
  return 'other';
}

// ---- Status change flow -----------------------------------------------------------------

export type StatusChangeOutcome =
  | { kind: 'changed'; task: Task }
  | { kind: 'invalid'; errors: FormErrors }
  /** Somebody changed the task first: `latest` is the reloaded task (null if it failed). */
  | { kind: 'conflict'; latest: Task | null }
  | { kind: 'refused'; refusal: TaskWriteRefusal; error: unknown };

export interface StatusChangeApi {
  changeStatus(id: string, body: ChangeTaskStatus): Promise<ApiResult<Task>>;
  get(id: string): Promise<ApiResult<Task>>;
}

/**
 * Sends a status change based on the version the user saw. On 409 `version_conflict` it does
 * NOT retry blindly: it reloads the task and returns it, so the screen shows the current state
 * and the user decides again (the next attempt carries the new version).
 */
export async function submitTaskStatusChange(
  api: StatusChangeApi,
  task: Task,
  status: TaskStatus,
  reason: string,
): Promise<StatusChangeOutcome> {
  const built = statusChangeBody(task, status, reason);
  if (!built.ok) {
    return { kind: 'invalid', errors: built.errors };
  }
  const result = await api.changeStatus(task.id, built.body);
  if (result.ok) {
    return { kind: 'changed', task: result.data };
  }
  const error = new ApiCallError(result.failure);
  const refusal = taskWriteRefusal(error);
  if (refusal === 'version_conflict') {
    const latest = await api.get(task.id);
    return { kind: 'conflict', latest: latest.ok ? latest.data : null };
  }
  return { kind: 'refused', refusal, error };
}

// ---- History --------------------------------------------------------------------------

export interface HistoryNames {
  user(id: string | null | undefined): string;
  site(id: string | null | undefined): string;
  team(id: string | null | undefined): string;
  dateTime(value: string): string;
  status(value: string): string;
  priority(value: string): string;
  none: string;
}

/** A value of a task history change as text: names for ids, org-zone times, labels. */
export function formatTaskHistoryValue(field: string, value: unknown, names: HistoryNames): string {
  if (value === null || value === undefined || value === '') return names.none;
  switch (field) {
    case 'assigneeIds':
      return Array.isArray(value) && value.length > 0
        ? value.map((id) => names.user(String(id))).join(', ')
        : names.none;
    case 'siteId':
      return names.site(String(value));
    case 'teamId':
      return names.team(String(value));
    case 'dueAt':
    case 'completedAt':
    case 'archivedAt':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value))
        ? names.dateTime(value)
        : String(value);
    case 'status':
      return names.status(String(value));
    case 'priority':
      return names.priority(String(value));
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/** The catalogue key of a history action (`task.status_changed` → `status_changed`). */
export function historyActionKey(action: string): string {
  const verb = action.startsWith('task.') ? action.slice('task.'.length) : action;
  return ['created', 'updated', 'status_changed', 'assignees_changed', 'archived'].includes(verb)
    ? verb
    : 'unknown';
}
