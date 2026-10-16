import { contextFor, orgWideContextFor } from '../testing';
import {
  canArchiveWorkLog,
  canChangeWorkLogStatus,
  canEditWorkLog,
  canReviewWorkLog,
  canSeeWorkLog,
  isWithinEditWindow,
  WORK_LOG_TRANSITIONS,
  type WorkLogFacts,
} from './work-log.rules';
import { canChangeAttachments } from './attachment.rules';

const NOW = new Date('2026-10-14T12:00:00Z');
const HOURS = 24;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

function log(overrides: Partial<WorkLogFacts> = {}): WorkLogFacts {
  return {
    authorId: 'worker',
    siteId: 'depot',
    teamId: 'electrical',
    status: 'submitted',
    createdAt: hoursAgo(1),
    ...overrides,
  };
}

const worker = contextFor('worker', ['worker'], {
  memberOf: { orgWide: false, siteIds: ['depot'], teamIds: [] },
});
const colleague = contextFor('colleague', ['worker']);
const depotSupervisor = contextFor('sup', ['supervisor'], {
  siteIds: ['depot'],
  userIds: ['sup', 'worker'],
});
const harbourSupervisor = contextFor('far', ['supervisor'], { siteIds: ['harbour'] });
const manager = orgWideContextFor('boss', 'manager');

describe('work log visibility', () => {
  it('lets a worker see their own logs and not a colleague’s', () => {
    expect(canSeeWorkLog(worker, log())).toBe(true);
    expect(canSeeWorkLog(colleague, log())).toBe(false);
  });

  it('lets a supervisor see logs of their site, of their people, and nothing else', () => {
    expect(canSeeWorkLog(depotSupervisor, log())).toBe(true);
    expect(canSeeWorkLog(depotSupervisor, log({ siteId: 'harbour', teamId: null }))).toBe(true);
    expect(
      canSeeWorkLog(depotSupervisor, log({ authorId: 'other', siteId: 'harbour', teamId: null })),
    ).toBe(false);
    expect(canSeeWorkLog(harbourSupervisor, log())).toBe(false);
  });

  it('lets a manager see every log', () => {
    expect(canSeeWorkLog(manager, log({ authorId: 'anyone', siteId: null, teamId: null }))).toBe(
      true,
    );
  });
});

describe('editing a work log', () => {
  it('allows the author inside the window while not approved', () => {
    expect(canEditWorkLog(worker, log(), NOW, HOURS)).toEqual({ allowed: true });
    expect(canEditWorkLog(worker, log({ status: 'rejected' }), NOW, HOURS).allowed).toBe(true);
  });

  it('counts the window edge as inside, and one millisecond later as outside', () => {
    expect(isWithinEditWindow(hoursAgo(24), NOW, 24)).toBe(true);
    expect(isWithinEditWindow(new Date(hoursAgo(24).getTime() - 1), NOW, 24)).toBe(false);
    expect(canEditWorkLog(worker, log({ createdAt: hoursAgo(25) }), NOW, HOURS)).toMatchObject({
      allowed: false,
      outcome: 'forbidden',
    });
    expect(canEditWorkLog(worker, log({ createdAt: hoursAgo(25) }), NOW, 48).allowed).toBe(true);
  });

  it('refuses an approved log, even to its author inside the window', () => {
    expect(canEditWorkLog(worker, log({ status: 'approved' }), NOW, HOURS)).toMatchObject({
      outcome: 'forbidden',
    });
  });

  it('refuses everybody else: 403 when they can see it, 404 when they cannot', () => {
    expect(canEditWorkLog(depotSupervisor, log(), NOW, HOURS)).toMatchObject({
      outcome: 'forbidden',
    });
    expect(canEditWorkLog(manager, log(), NOW, HOURS)).toMatchObject({ outcome: 'forbidden' });
    expect(canEditWorkLog(colleague, log(), NOW, HOURS)).toMatchObject({ outcome: 'not_found' });
  });
});

describe('reviewing a work log', () => {
  it('lets a supervisor in scope and a manager review, never the author', () => {
    expect(canReviewWorkLog(depotSupervisor, log()).allowed).toBe(true);
    expect(canReviewWorkLog(manager, log()).allowed).toBe(true);
    expect(canReviewWorkLog(harbourSupervisor, log())).toMatchObject({ outcome: 'not_found' });
    expect(canReviewWorkLog(worker, log())).toMatchObject({ outcome: 'forbidden' });
  });

  it('never lets a supervisor approve their own log', () => {
    const own = log({ authorId: 'sup' });
    expect(canChangeWorkLogStatus(depotSupervisor, own, 'approved', NOW, HOURS)).toMatchObject({
      outcome: 'forbidden',
      reason: 'You cannot review your own work log',
    });
    const managersOwn = log({ authorId: 'boss' });
    expect(canChangeWorkLogStatus(manager, managersOwn, 'approved', NOW, HOURS)).toMatchObject({
      outcome: 'forbidden',
    });
  });
});

describe('status transitions', () => {
  it.each([
    ['draft', 'submitted'],
    ['submitted', 'draft'],
    ['rejected', 'submitted'],
  ] as const)('lets the author move %s -> %s inside the window', (from, to) => {
    expect(canChangeWorkLogStatus(worker, log({ status: from }), to, NOW, HOURS).allowed).toBe(
      true,
    );
    expect(
      canChangeWorkLogStatus(worker, log({ status: from, createdAt: hoursAgo(30) }), to, NOW, HOURS)
        .allowed,
    ).toBe(false);
  });

  it.each([
    ['submitted', 'approved'],
    ['submitted', 'rejected'],
    ['approved', 'submitted'],
    ['rejected', 'submitted'],
  ] as const)('lets a reviewer move %s -> %s, whatever the window', (from, to) => {
    const old = log({ status: from, createdAt: hoursAgo(500) });
    expect(canChangeWorkLogStatus(depotSupervisor, old, to, NOW, HOURS).allowed).toBe(true);
  });

  it('does not let the author approve, reject or reopen', () => {
    for (const to of ['approved', 'rejected'] as const) {
      expect(canChangeWorkLogStatus(worker, log(), to, NOW, HOURS)).toMatchObject({
        outcome: 'forbidden',
      });
    }
    expect(
      canChangeWorkLogStatus(worker, log({ status: 'approved' }), 'submitted', NOW, HOURS),
    ).toMatchObject({ outcome: 'forbidden' });
  });

  it('answers conflict for a move that exists for nobody', () => {
    expect(
      canChangeWorkLogStatus(manager, log({ status: 'draft' }), 'approved', NOW, HOURS),
    ).toMatchObject({ outcome: 'conflict' });
    expect(
      WORK_LOG_TRANSITIONS.some((move) => move.from === 'draft' && move.to === 'approved'),
    ).toBe(false);
  });
});

describe('archiving a log and its attachments', () => {
  it('lets the author archive under the edit rule, and a reviewer anytime', () => {
    expect(canArchiveWorkLog(worker, log(), NOW, HOURS).allowed).toBe(true);
    expect(canArchiveWorkLog(worker, log({ createdAt: hoursAgo(48) }), NOW, HOURS).allowed).toBe(
      false,
    );
    expect(
      canArchiveWorkLog(depotSupervisor, log({ status: 'approved' }), NOW, HOURS).allowed,
    ).toBe(true);
  });

  it('applies the same rule to attachments', () => {
    expect(canChangeAttachments(worker, log(), NOW, HOURS).allowed).toBe(true);
    expect(canChangeAttachments(worker, log({ status: 'approved' }), NOW, HOURS).allowed).toBe(
      false,
    );
    expect(canChangeAttachments(manager, log(), NOW, HOURS).allowed).toBe(true);
    expect(canChangeAttachments(colleague, log(), NOW, HOURS)).toMatchObject({
      outcome: 'not_found',
    });
  });
});
