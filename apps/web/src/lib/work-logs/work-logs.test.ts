import type {
  ApiErrorCode,
  ApiFailure,
  BulkWorkLogStatusResult,
  DashboardOverview,
  RecordHistoryEntry,
  WorkLog,
} from '@ops/shared';
import { describe, expect, it } from 'vitest';

import { t } from '@/i18n';
import { ApiCallError } from '@/lib/api/errors';
import { exportErrorMessage, exportFileName } from '@/lib/exports';
import { applyListChange, readListState } from '@/lib/list-params';
import { overviewCards, placeRows } from '@/lib/overview';
import { capabilitiesFor } from '@/lib/permissions';
import { barPercent, dayCount, readReportParams } from '@/lib/report';
import { createOrgTime, orgTimeGate } from '@/lib/time';

import {
  dayRangeFilters,
  dayRangeOf,
  exportQueryOf,
  mapHrefOf,
  mapQueryOf,
  reportHrefOf,
  WORK_LOG_LIST_FILTER_KEYS,
  workLogHref,
} from './filters';
import { customFieldRows, excerptOf, formatDuration, historyLineOf, syncFactsOf } from './format';
import { markerToneOf } from './map-points';
import { afterPhotoError, afterPhotoLoad, INITIAL_PHOTO_RETRY, photoErrorAction } from './photos';
import {
  bulkItemsOf,
  bulkOutcomeRows,
  isBulkSelectable,
  pruneSelection,
  reviewErrorOf,
  reviewRefusalMessage,
  reviewStateMessage,
  reviewStateOf,
  workLogListFeatures,
} from './review';

const ME = '0190f3a2-7c1e-7000-8000-000000000001';
const OTHER = '0190f3a2-7c1e-7000-8000-000000000002';
const LOG_A = '0190f3a2-7c1e-7000-8000-0000000000a1';
const LOG_B = '0190f3a2-7c1e-7000-8000-0000000000a2';
const LOG_C = '0190f3a2-7c1e-7000-8000-0000000000a3';
const LOG_D = '0190f3a2-7c1e-7000-8000-0000000000a4';

const worker = capabilitiesFor(['worker']);
const supervisor = capabilitiesFor(['worker', 'supervisor']);
const manager = capabilitiesFor(['manager']);
const admin = capabilitiesFor(['admin']);

function log(overrides: Partial<WorkLog> = {}): WorkLog {
  return {
    id: LOG_A,
    organizationId: '0190f3a2-7c1e-7000-8000-0000000000f0',
    clientId: '0190f3a2-7c1e-7000-8000-0000000000c0',
    authorId: OTHER,
    occurredAt: '2026-10-28T11:05:00.000Z',
    taskId: null,
    siteId: null,
    teamId: null,
    logTypeId: null,
    logTypeVersion: null,
    text: 'Checked the pumps',
    customFields: {},
    location: null,
    status: 'submitted',
    review: null,
    source: 'manual',
    aiMetadata: null,
    version: 3,
    submittedOffline: false,
    deviceCreatedAt: null,
    clockSkewSeconds: null,
    clockSkewFlagged: false,
    declaredAttachmentClientIds: [],
    attachmentCount: 0,
    createdAt: '2026-10-28T11:06:00.000Z',
    updatedAt: '2026-10-28T11:06:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function httpFailure(status: number, code: ApiErrorCode, message = 'refused'): ApiFailure {
  return {
    kind: 'http',
    status,
    message,
    error: {
      statusCode: status,
      code,
      message,
      correlationId: null,
      timestamp: '2026-10-28T12:00:00.000Z',
    },
  };
}

const istanbul = createOrgTime('Europe/Istanbul');
const berlin = createOrgTime('Europe/Berlin');

describe('work-log list features by role (useCaller capabilities)', () => {
  it('offers workers nothing', () => {
    expect(workLogListFeatures(worker)).toEqual({
      bulkReview: false,
      exportCsv: false,
      report: false,
      map: false,
    });
  });

  it.each([
    ['supervisor', supervisor],
    ['manager', manager],
    ['admin', admin],
  ])('offers a %s bulk review, export, report and map', (_name, capabilities) => {
    expect(workLogListFeatures(capabilities)).toEqual({
      bulkReview: true,
      exportCsv: true,
      report: true,
      map: true,
    });
  });
});

describe('review state (no self-approval in the UI)', () => {
  it('never offers a review of the caller’s own log, whatever the role', () => {
    for (const capabilities of [supervisor, manager, admin]) {
      const state = reviewStateOf(capabilities, ME, log({ authorId: ME }));
      expect(state).toEqual({ kind: 'self' });
      expect(reviewStateMessage(state)).toBe(t('workLogs.review.self'));
    }
  });

  it('offers approve and reject on a submitted log of somebody else', () => {
    expect(reviewStateOf(supervisor, ME, log())).toEqual({
      kind: 'available',
      approve: true,
      reject: true,
    });
    expect(reviewStateMessage({ kind: 'available', approve: true, reject: true })).toBeNull();
  });

  it('does not offer the status the log already has', () => {
    expect(reviewStateOf(manager, ME, log({ status: 'approved' }))).toEqual({
      kind: 'available',
      approve: false,
      reject: true,
    });
    expect(reviewStateOf(manager, ME, log({ status: 'rejected' }))).toEqual({
      kind: 'available',
      approve: true,
      reject: false,
    });
  });

  it('explains drafts, archived logs and roles that cannot review', () => {
    expect(reviewStateOf(admin, ME, log({ status: 'draft' }))).toEqual({ kind: 'draft' });
    expect(reviewStateOf(admin, ME, log({ archivedAt: '2026-10-28T12:00:00.000Z' }))).toEqual({
      kind: 'archived',
    });
    expect(reviewStateOf(worker, ME, log())).toEqual({ kind: 'notReviewer' });
    expect(reviewStateMessage({ kind: 'draft' })).toBe(t('workLogs.review.draft'));
  });
});

describe('bulk selection', () => {
  const rows = [
    log({ id: LOG_A }),
    log({ id: LOG_B, authorId: ME }),
    log({ id: LOG_C, status: 'draft' }),
    log({ id: LOG_D, version: 7, status: 'rejected' }),
  ];

  it('never lets the caller select their own log', () => {
    expect(isBulkSelectable(supervisor, ME, rows[1]!)).toBe(false);
    expect(isBulkSelectable(supervisor, ME, rows[0]!)).toBe(true);
    expect(isBulkSelectable(worker, OTHER, rows[0]!)).toBe(false);
  });

  it('sends only selectable rows, with their versions, even if an own log was selected', () => {
    const selected = new Set([LOG_A, LOG_B, LOG_C, LOG_D]);
    expect(bulkItemsOf(rows, selected, manager, ME)).toEqual([
      { id: LOG_A, expectedVersion: 3 },
      { id: LOG_D, expectedVersion: 7 },
    ]);
  });

  it('prunes ids that left the page or cannot be reviewed', () => {
    const selected = new Set([LOG_A, LOG_B, '0190f3a2-7c1e-7000-8000-0000000000ff']);
    expect([...pruneSelection(selected, rows, admin, ME)]).toEqual([LOG_A]);
  });

  it('turns per-item results into lines with the typed reason', () => {
    const result: BulkWorkLogStatusResult = {
      succeeded: 1,
      failed: 2,
      results: [
        { ok: true, id: LOG_A, workLog: log({ status: 'approved' }) },
        {
          ok: false,
          id: LOG_B,
          error: { statusCode: 403, code: 'forbidden', message: 'own log' },
        },
        {
          ok: false,
          id: LOG_D,
          error: { statusCode: 409, code: 'version_conflict', message: 'stale' },
        },
      ],
    };
    expect(bulkOutcomeRows(result)).toEqual([
      { id: LOG_A, ok: true, reason: null },
      { id: LOG_B, ok: false, reason: t('workLogs.review.errors.forbidden') },
      { id: LOG_D, ok: false, reason: t('workLogs.review.errors.versionConflict') },
    ]);
  });
});

describe('review refusals', () => {
  it('maps typed codes to sentences and keeps the server message for validation', () => {
    expect(reviewRefusalMessage({ code: 'already_reviewed', message: 'x' })).toBe(
      t('workLogs.review.errors.alreadyReviewed'),
    );
    expect(reviewRefusalMessage({ code: 'record_archived', message: 'x' })).toBe(
      t('workLogs.review.errors.archived'),
    );
    expect(reviewRefusalMessage({ code: 'validation_failed', message: 'note is required' })).toBe(
      t('workLogs.review.errors.validation', { message: 'note is required' }),
    );
    expect(reviewRefusalMessage({ code: 'internal_error', message: 'Boom' })).toBe('Boom');
  });

  it('reads the reason of a thrown ApiCallError only', () => {
    expect(reviewErrorOf(new ApiCallError(httpFailure(403, 'forbidden')))).toEqual({
      code: 'forbidden',
      message: 'refused',
    });
    expect(reviewErrorOf(new ApiCallError({ kind: 'network', message: 'down' }))).toBeNull();
    expect(reviewErrorOf(new Error('x'))).toBeNull();
  });
});

describe('filters in the URL', () => {
  it('round-trips a day range through the URL in the organization’s zone', () => {
    const filters = dayRangeFilters({ from: '2026-10-20', to: '2026-10-28' }, istanbul);
    expect(filters).toEqual({
      occurredFrom: '2026-10-19T21:00:00.000Z',
      occurredTo: '2026-10-28T21:00:00.000Z',
    });
    const search = applyListChange(new URLSearchParams('page=3&status=submitted'), {
      filters: filters!,
    });
    const state = readListState(new URLSearchParams(search), WORK_LOG_LIST_FILTER_KEYS);
    expect(state.page).toBe(1);
    expect(state.filters.status).toBe('submitted');
    expect(dayRangeOf(state.filters, istanbul.timeZone)).toEqual({
      from: '2026-10-20',
      to: '2026-10-28',
    });
  });

  it('keeps whole local days across a daylight-saving change (Berlin)', () => {
    const filters = dayRangeFilters({ from: '2026-10-24', to: '2026-10-25' }, berlin);
    expect(filters).toEqual({
      occurredFrom: '2026-10-23T22:00:00.000Z',
      occurredTo: '2026-10-25T23:00:00.000Z',
    });
    expect(dayRangeOf(filters as Record<string, string>, berlin.timeZone)).toEqual({
      from: '2026-10-24',
      to: '2026-10-25',
    });
  });

  it('clears one side, and refuses an inverted range', () => {
    expect(dayRangeFilters({ from: null, to: null }, istanbul)).toEqual({
      occurredFrom: null,
      occurredTo: null,
    });
    expect(dayRangeFilters({ from: '2026-10-28', to: '2026-10-01' }, istanbul)).toBeNull();
  });

  it('ignores unknown parameters and keeps the API names', () => {
    const state = readListState(
      new URLSearchParams('siteId=s1&hasPhotos=true&search=pump&evil=1&sort=status:desc&page=2'),
      WORK_LOG_LIST_FILTER_KEYS,
    );
    expect(state.filters).toEqual({ siteId: 's1', hasPhotos: 'true', search: 'pump' });
    expect(exportQueryOf(state)).toEqual({
      siteId: 's1',
      hasPhotos: 'true',
      search: 'pump',
      sort: 'status:desc',
    });
    expect(mapQueryOf(state.filters, 200)).toEqual({
      siteId: 's1',
      hasPhotos: 'true',
      search: 'pump',
      limit: 200,
    });
  });

  it('builds report and map links from the list filters', () => {
    const filters = {
      siteId: 's1',
      search: 'pump',
      hasPhotos: 'true',
      occurredFrom: '2026-10-19T21:00:00.000Z',
    };
    expect(reportHrefOf(filters)).toBe(
      '/work-logs/report?occurredFrom=2026-10-19T21%3A00%3A00.000Z&siteId=s1',
    );
    expect(mapHrefOf({ status: 'submitted' })).toBe('/map?status=submitted');
    expect(workLogHref(LOG_A)).toBe(`/work-logs/${LOG_A}`);
  });
});

describe('time-zone display', () => {
  it('shows instants in the organization’s zone, not the browser’s', () => {
    expect(istanbul.time('2026-10-28T11:05:00.000Z')).toBe('14:05');
    expect(createOrgTime('UTC').time('2026-10-28T11:05:00.000Z')).toBe('11:05');
    expect(istanbul.dayOf('2026-10-28T22:30:00.000Z')).toBe('2026-10-29');
  });

  it('formats custom fields by type: dates stay the calendar day, datetimes in the org zone', () => {
    const rows = customFieldRows(
      [
        { key: 'checked', label: 'Checked', type: 'boolean', required: false },
        { key: 'pressure', label: 'Pressure', type: 'number', required: true },
        { key: 'due', label: 'Due', type: 'date', required: false },
        { key: 'seen', label: 'Seen', type: 'date', required: false },
        { key: 'note', label: 'Note', type: 'text', required: false, helpText: 'Free text' },
      ],
      {
        checked: true,
        pressure: 1234.5,
        due: '2026-10-28',
        seen: '2026-10-28T11:05:00Z',
        old: 'x',
      },
      istanbul,
    );
    expect(rows.map((row) => [row.label, row.value, row.removed])).toEqual([
      ['Checked', t('workLogs.fields.yes'), false],
      ['Pressure', '1,234.5', false],
      ['Due', '28 Oct 2026', false],
      ['Seen', '28 Oct 2026, 14:05', false],
      ['Note', t('workLogs.fields.noValue'), false],
      ['old', 'x', true],
    ]);
    expect(rows[4]!.help).toBe('Free text');
  });

  it('shows raw keys when the definitions could not be loaded', () => {
    expect(customFieldRows(null, { a: 1 }, istanbul)).toEqual([
      { key: 'a', label: 'a', value: '1', help: null, removed: false },
    ]);
    expect(customFieldRows([], {}, istanbul)).toEqual([]);
  });

  it('writes the offline-sync facts with the phone time in the org zone', () => {
    const facts = syncFactsOf(
      log({
        submittedOffline: true,
        deviceCreatedAt: '2026-10-28T11:00:05.000Z',
        clockSkewSeconds: -185,
        clockSkewFlagged: true,
      }),
      istanbul,
    );
    expect(facts.offline).toBe(true);
    expect(facts.flagged).toBe(true);
    expect(facts.deviceTime).toContain('14:00:05');
    expect(facts.skew).toBe(
      t('workLogs.sync.skewValue', {
        value: t('workLogs.sync.skewBehind', { amount: t('workLogs.sync.minutes', { count: 3 }) }),
      }),
    );
    expect(syncFactsOf(log(), istanbul)).toEqual({
      offline: false,
      deviceTime: null,
      skew: null,
      flagged: false,
    });
    expect(syncFactsOf(log({ clockSkewSeconds: 0 }), istanbul).skew).toBe(
      t('workLogs.sync.skewNone'),
    );
  });

  it('rounds durations down to the largest unit', () => {
    expect(formatDuration(45)).toBe('45 seconds');
    expect(formatDuration(-60)).toBe('1 minute');
    expect(formatDuration(7300)).toBe('2 hours');
  });
});

describe('history lines', () => {
  const base: RecordHistoryEntry = {
    id: '0190f3a2-7c1e-7000-8000-0000000000e1',
    action: 'work_log.status_changed',
    entityType: 'work_log',
    entityId: LOG_A,
    occurredAt: '2026-10-28T12:00:00.000Z',
    actorType: 'user',
    actorId: OTHER,
    actorName: 'Selin',
    changes: { status: { from: 'submitted', to: 'approved' }, review: { from: null, to: {} } },
    offline: false,
  };

  it('describes a status change with the actor', () => {
    expect(historyLineOf(base)).toMatchObject({
      title: t('workLogs.history.actions.workLogStatusChanged'),
      actor: t('workLogs.history.by', { name: 'Selin' }),
      statusChange: t('workLogs.history.statusChange', {
        from: t('status.workLog.submitted'),
        to: t('status.workLog.approved'),
      }),
      changed: t('workLogs.history.changed', { fields: 'review' }),
    });
  });

  it('says "Someone" for a user the caller cannot see, and names the system', () => {
    expect(historyLineOf({ ...base, actorName: null }).actor).toBe(
      t('workLogs.history.by', { name: t('common.someone') }),
    );
    expect(historyLineOf({ ...base, actorType: 'system', actorId: null }).actor).toBe(
      t('workLogs.history.system'),
    );
  });

  it('keeps unknown actions readable and photo events without field lists', () => {
    expect(historyLineOf({ ...base, action: 'work_log.merged', changes: null }).title).toBe(
      t('workLogs.history.actions.unknownAction', { action: 'work_log.merged' }),
    );
    const photo = historyLineOf({
      ...base,
      action: 'attachment.completed',
      entityType: 'attachment',
      changes: { archivedAt: { from: null, to: null } },
      offline: true,
    });
    expect(photo.title).toBe(t('workLogs.history.actions.attachmentCompleted'));
    expect(photo.changed).toBeNull();
    expect(photo.offline).toBe(true);
  });
});

describe('CSV export errors', () => {
  it('explains export_too_large with the row cap', () => {
    const message = exportErrorMessage(httpFailure(422, 'export_too_large', 'too many'));
    expect(message).toBe(t('csvExport.tooLarge', { max: '10,000' }));
    expect(message).toContain('10,000');
  });

  it('says the role cannot export on 403, and the generic reason otherwise', () => {
    expect(exportErrorMessage(httpFailure(403, 'forbidden'))).toBe(t('csvExport.forbidden'));
    expect(exportErrorMessage({ kind: 'network', message: 'down' })).toBe(
      t('csvExport.failed', { reason: t('states.offline') }),
    );
    expect(exportErrorMessage(httpFailure(400, 'validation_failed', 'sort is invalid'))).toBe(
      t('csvExport.failed', { reason: 'sort is invalid' }),
    );
  });

  it('names the file after the organization’s day', () => {
    expect(exportFileName('workLogs', '2026-10-28')).toBe('work-logs-2026-10-28.csv');
    expect(exportFileName('tasks', '2026-10-28')).toBe('tasks-2026-10-28.csv');
  });
});

describe('overview links', () => {
  const linked = (count: number, filter: Record<string, string>) => ({ count, filter });
  const overview: DashboardOverview = {
    generatedAt: '2026-10-28T12:00:00.000Z',
    timeZone: 'Europe/Istanbul',
    day: '2026-10-28',
    dayStart: '2026-10-27T21:00:00.000Z',
    dayEnd: '2026-10-28T21:00:00.000Z',
    logsToday: linked(4, {
      occurredFrom: '2026-10-27T21:00:00.000Z',
      occurredTo: '2026-10-28T21:00:00.000Z',
    }),
    logsAwaitingApproval: linked(2, { status: 'submitted' }),
    tasksOpen: linked(5, { open: 'true' }),
    tasksOverdue: linked(0, { overdue: 'true' }),
    tasksBlocked: linked(1, { status: 'blocked' }),
    bySite: [
      {
        id: null,
        name: null,
        logsToday: 1,
        tasksOpen: 0,
        logsFilter: { status: 'submitted' },
        tasksFilter: { open: 'true' },
      },
    ],
    byTeam: [],
    idleWorkers: { total: 0, items: [], truncated: false },
  };

  it('links every number to its filtered list with the API’s filter', () => {
    const cards = overviewCards(overview);
    expect(cards.map((card) => [card.key, card.count, card.href, card.attention])).toEqual([
      [
        'logsToday',
        4,
        '/work-logs?occurredFrom=2026-10-27T21%3A00%3A00.000Z&occurredTo=2026-10-28T21%3A00%3A00.000Z',
        false,
      ],
      ['logsAwaitingApproval', 2, '/work-logs?status=submitted', true],
      ['tasksOpen', 5, '/tasks?open=true', false],
      ['tasksOverdue', 0, '/tasks?overdue=true', false],
      ['tasksBlocked', 1, '/tasks?status=blocked', true],
    ]);
  });

  it('names a place the caller cannot see apart from the row without a place', () => {
    const rows = placeRows(
      [
        { ...overview.bySite[0]!, id: null, name: null },
        { ...overview.bySite[0]!, id: LOG_A, name: null },
        { ...overview.bySite[0]!, id: LOG_B, name: 'North yard' },
      ],
      'No site',
    );
    expect(rows.map((row) => row.name)).toEqual([
      'No site',
      t('overview.activity.unknownPlace'),
      'North yard',
    ]);
  });

  it('names the row without a place', () => {
    expect(placeRows(overview.bySite, 'No site')).toEqual([
      {
        key: 'none',
        name: 'No site',
        logsToday: 1,
        tasksOpen: 0,
        logsHref: '/work-logs?status=submitted',
        tasksHref: '/tasks?open=true',
      },
    ]);
  });
});

describe('report parameters', () => {
  const now = new Date('2026-10-28T12:00:00.000Z');

  it('defaults to the last 7 days in the organization’s zone', () => {
    const parsed = readReportParams(new URLSearchParams(), istanbul, now);
    expect(parsed).toEqual({
      ok: true,
      days: { from: '2026-10-22', to: '2026-10-28' },
      query: { occurredFrom: '2026-10-21T21:00:00.000Z', occurredTo: '2026-10-28T21:00:00.000Z' },
    });
  });

  it('keeps the list range and the report filters, drops the others', () => {
    const parsed = readReportParams(
      new URLSearchParams(
        'occurredFrom=2026-10-19T21:00:00.000Z&occurredTo=2026-10-28T21:00:00.000Z&siteId=s1&search=x',
      ),
      istanbul,
      now,
    );
    expect(parsed.ok && parsed.query).toEqual({
      occurredFrom: '2026-10-19T21:00:00.000Z',
      occurredTo: '2026-10-28T21:00:00.000Z',
      siteId: 's1',
    });
  });

  it('refuses a range longer than 92 days or missing a side', () => {
    const tooLong = readReportParams(
      new URLSearchParams(
        'occurredFrom=2026-01-01T00:00:00.000Z&occurredTo=2026-10-28T21:00:00.000Z',
      ),
      istanbul,
      now,
    );
    expect(tooLong).toMatchObject({ ok: false, message: t('report.tooLong', { days: 92 }) });
    const half = readReportParams(
      new URLSearchParams('occurredFrom=2026-10-19T21:00:00.000Z'),
      istanbul,
      now,
    );
    expect(half).toMatchObject({ ok: false, message: t('report.needRange') });
  });

  it('counts days and bar widths', () => {
    expect(dayCount('2026-10-01', '2026-10-01')).toBe(1);
    expect(dayCount('2026-10-01', '2026-12-31')).toBe(92);
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(0, 0)).toBe(0);
  });
});

describe('small display helpers', () => {
  it('shortens text for table cells and marks empty text', () => {
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf('   ')).toBeNull();
    expect(excerptOf('a\n  b')).toBe('a b');
    expect(excerptOf('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('colours markers like the status badges', () => {
    expect(markerToneOf('submitted')).toBe('warning');
    expect(markerToneOf('approved')).toBe('success');
    expect(markerToneOf('rejected')).toBe('danger');
    expect(markerToneOf('draft')).toBe('muted');
  });
});

describe('photo URL refresh (no endless refetch)', () => {
  it('refetches once per failed URL set, then gives up when the fresh set fails too', () => {
    let state = INITIAL_PHOTO_RETRY;
    expect(photoErrorAction(state, 100)).toBe('refetch');
    state = afterPhotoError(state, 100);
    // Other thumbnails of the same set fail while the refetch runs: wait, no second refetch.
    expect(photoErrorAction(state, 100)).toBe('wait');
    expect(afterPhotoError(state, 100)).toBe(state);
    // The fresh set (fetched at 200) fails too: storage unreachable, stop.
    expect(photoErrorAction(state, 200)).toBe('giveUp');
    state = afterPhotoError(state, 200);
    expect(state.gaveUp).toBe(true);
    expect(photoErrorAction(state, 300)).toBe('wait');
  });

  it('allows a later refresh once a fresh set has loaded', () => {
    let state = afterPhotoError(INITIAL_PHOTO_RETRY, 100);
    expect(afterPhotoLoad(state, 100)).toBe(state);
    state = afterPhotoLoad(state, 200);
    expect(state).toEqual(INITIAL_PHOTO_RETRY);
    expect(photoErrorAction(state, 500)).toBe('refetch');
  });
});

describe('organization time zone gate', () => {
  it('waits for GET /organization instead of using the Istanbul fallback', () => {
    expect(orgTimeGate({ data: undefined, isError: false })).toBe('loading');
    expect(orgTimeGate({ data: undefined, isError: true })).toBe('error');
    expect(orgTimeGate({ data: { timeZone: 'Europe/Berlin' }, isError: false })).toBe('ready');
    // A cached organization stays usable while a background refresh fails.
    expect(orgTimeGate({ data: { timeZone: 'Europe/Berlin' }, isError: true })).toBe('ready');
  });
});
