import { contextFor, orgWideContextFor } from '../testing';
import { codeOf, enforce } from '../decision';
import {
  canContinueAttachmentUpload,
  canStartAttachmentUpload,
  isWithinDays,
  type UploadWorkLogFacts,
} from './attachment.rules';
import { canChangeTaskStatus, type TaskFacts } from './task.rules';
import { canChangeWorkLogStatus, canEditWorkLog } from './work-log.rules';

// Phase 5 (ADR-0008): the typed refusal codes and the declared-photo rule.

const NOW = new Date('2026-10-27T12:00:00Z');
const HOURS = 24;
const GRACE = 30;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const daysAgo = (days: number) => hoursAgo(days * 24);
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';

const worker = contextFor('worker', ['worker']);
const colleague = contextFor('colleague', ['worker']);
const supervisor = contextFor('sup', ['supervisor'], { siteIds: ['depot'], userIds: ['worker'] });
const manager = orgWideContextFor('boss', 'manager');

function log(overrides: Partial<UploadWorkLogFacts> = {}): UploadWorkLogFacts {
  return {
    authorId: 'worker',
    siteId: 'depot',
    teamId: null,
    status: 'submitted',
    createdAt: hoursAgo(1),
    declaredAttachmentClientIds: [A1],
    ...overrides,
  };
}

describe('typed refusal codes of the work-log rules', () => {
  it('answers already_reviewed (409) for the author of an approved log', () => {
    const decision = canEditWorkLog(worker, log({ status: 'approved' }), NOW, HOURS);
    expect(decision).toMatchObject({ outcome: 'conflict', code: 'already_reviewed' });
    expect(() => enforce(decision, 'Work log')).toThrow(
      expect.objectContaining({ code: 'already_reviewed', status: 409 }),
    );
  });

  it('answers edit_window_closed (403) after the window, for edit and status move', () => {
    const old = log({ createdAt: hoursAgo(25) });
    expect(codeOf(canEditWorkLog(worker, old, NOW, HOURS))).toBe('edit_window_closed');
    expect(codeOf(canChangeWorkLogStatus(worker, old, 'draft', NOW, HOURS))).toBe(
      'edit_window_closed',
    );
  });

  it('keeps the generic forbidden for somebody else and 404 for an invisible log', () => {
    expect(canEditWorkLog(supervisor, log(), NOW, HOURS)).toMatchObject({
      outcome: 'forbidden',
    });
    expect(codeOf(canEditWorkLog(supervisor, log(), NOW, HOURS))).toBeNull();
    expect(canEditWorkLog(colleague, log(), NOW, HOURS)).toMatchObject({ outcome: 'not_found' });
  });
});

describe('typed refusal codes of the task rules', () => {
  const task = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({
    siteId: 'depot',
    teamId: null,
    createdById: 'sup',
    assigneeIds: ['worker'],
    status: 'todo',
    ...overrides,
  });

  it('answers task_not_assigned to a caller who sees the task but is not an assignee', () => {
    const visibleToWorker = contextFor('worker2', ['worker'], { siteIds: ['depot'] });
    expect(canChangeTaskStatus(visibleToWorker, task(), 'done')).toMatchObject({
      outcome: 'forbidden',
      code: 'task_not_assigned',
    });
  });

  it('answers task_cancelled to an assignee of a cancelled task; a manager may reopen it', () => {
    expect(codeOf(canChangeTaskStatus(worker, task({ status: 'cancelled' }), 'todo'))).toBe(
      'task_cancelled',
    );
    expect(canChangeTaskStatus(manager, task({ status: 'cancelled' }), 'todo').allowed).toBe(true);
  });
});

describe('starting a photo upload (declared photos)', () => {
  const start = (context: typeof worker, facts: UploadWorkLogFacts, clientId: string | null) =>
    canStartAttachmentUpload(context, facts, clientId, NOW, HOURS, GRACE);

  it('allows the normal rule inside the window, declared or not', () => {
    expect(start(worker, log(), null).allowed).toBe(true);
    expect(start(worker, log(), A2).allowed).toBe(true);
  });

  it('allows a reviewer as before', () => {
    expect(start(supervisor, log({ createdAt: daysAgo(40) }), null).allowed).toBe(true);
  });

  it('allows the author a declared photo after the window, within the grace days', () => {
    expect(start(worker, log({ createdAt: daysAgo(10) }), A1).allowed).toBe(true);
    expect(start(worker, log({ createdAt: daysAgo(30) }), A1).allowed).toBe(true);
  });

  it('allows a declared photo on an approved log (the review must not lose it)', () => {
    expect(start(worker, log({ status: 'approved', createdAt: daysAgo(3) }), A1).allowed).toBe(
      true,
    );
  });

  it('refuses an undeclared photo after the window: attachment_not_declared', () => {
    expect(codeOf(start(worker, log({ createdAt: daysAgo(2) }), A2))).toBe(
      'attachment_not_declared',
    );
    expect(codeOf(start(worker, log({ createdAt: daysAgo(2) }), null))).toBe(
      'attachment_not_declared',
    );
  });

  it('refuses an undeclared photo on an approved log inside the window: already_reviewed', () => {
    expect(codeOf(start(worker, log({ status: 'approved' }), A2))).toBe('already_reviewed');
  });

  it('refuses a declared photo after the grace days: edit_window_closed', () => {
    expect(codeOf(start(worker, log({ createdAt: daysAgo(31) }), A1))).toBe('edit_window_closed');
  });

  it('never extends the declared rule to anybody but the author', () => {
    const otherWorker = contextFor('other', ['worker'], { siteIds: ['depot'] });
    expect(start(otherWorker, log({ createdAt: daysAgo(2) }), A1)).toMatchObject({
      outcome: 'forbidden',
    });
    expect(start(colleague, log(), A1)).toMatchObject({ outcome: 'not_found' });
  });
});

describe('renewing or completing a pending upload', () => {
  const cont = (context: typeof worker, createdAt: Date, attachmentAt: Date, by = 'worker') =>
    canContinueAttachmentUpload(
      context,
      log({ createdAt }),
      { uploadedById: by, createdAt: attachmentAt },
      NOW,
      HOURS,
      GRACE,
    );

  it('lets the uploader finish after the window closed, within the grace days', () => {
    expect(cont(worker, daysAgo(3), daysAgo(2)).allowed).toBe(true);
  });

  it('refuses after the grace days, and to somebody who did not start it', () => {
    expect(codeOf(cont(worker, daysAgo(40), daysAgo(31)))).toBe('edit_window_closed');
    expect(cont(worker, daysAgo(3), daysAgo(1), 'someone-else').allowed).toBe(false);
  });

  it('isWithinDays includes the boundary', () => {
    expect(isWithinDays(daysAgo(30), NOW, 30)).toBe(true);
    expect(isWithinDays(new Date(daysAgo(30).getTime() - 1), NOW, 30)).toBe(false);
  });
});
