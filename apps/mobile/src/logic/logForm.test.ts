import { customFieldDefinitionsSchema, type LogType, type WorkLog } from '@ops/shared';

import {
  buildCreateBody,
  buildUpdateBody,
  errorsFromApiDetails,
  hasLogFormErrors,
  logFormValuesFromLog,
  newLogFormValues,
  withLogType,
} from './logForm';

const NOW = new Date('2026-10-16T12:00:00Z');
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

const inspection: LogType = {
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: '33333333-3333-4333-8333-333333333333',
  key: 'inspection',
  name: 'Inspection',
  description: null,
  fields: customFieldDefinitionsSchema.parse([
    { key: 'area', label: 'Area', type: 'text', required: true },
    { key: 'count', label: 'Count', type: 'number' },
    { key: 'passed', label: 'Passed', type: 'boolean', required: true },
    { key: 'result', label: 'Result', type: 'select', options: ['ok', 'defect'] },
    { key: 'next', label: 'Next check', type: 'date' },
  ]),
  version: 3,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  archivedAt: null,
};

const delivery: LogType = {
  ...inspection,
  id: '44444444-4444-4444-8444-444444444444',
  key: 'delivery',
  name: 'Delivery',
  fields: customFieldDefinitionsSchema.parse([
    { key: 'area', label: 'Area', type: 'text' },
    { key: 'count', label: 'Pallets', type: 'number', required: true },
  ]),
};

function filled() {
  return {
    ...withLogType(newLogFormValues(CLIENT_ID), inspection),
    customFields: { area: 'Hall B', count: '12,5', passed: true, result: 'ok', next: '2026-11-01' },
    text: '  Checked the north wall.  ',
  };
}

describe('buildCreateBody', () => {
  it('builds the POST body with the phone-made clientId and converted custom fields', () => {
    const result = buildCreateBody(
      { ...filled(), location: { latitude: 41, longitude: 29, accuracy: 8 } },
      inspection,
      0,
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      body: {
        clientId: CLIENT_ID,
        occurredAt: NOW.toISOString(),
        logTypeId: inspection.id,
        customFields: {
          area: 'Hall B',
          count: 12.5,
          passed: true,
          result: 'ok',
          next: '2026-11-01',
        },
        text: 'Checked the north wall.',
        taskId: null,
        siteId: null,
        teamId: null,
        location: { latitude: 41, longitude: 29, accuracy: 8 },
        status: 'submitted',
        source: 'manual',
      },
    });
  });

  it('keeps the same clientId on every attempt, so a retried save cannot duplicate', () => {
    const values = filled();
    const first = buildCreateBody(values, inspection, 0, NOW);
    const second = buildCreateBody(values, inspection, 0, new Date(NOW.getTime() + 60_000));
    expect(first.ok && second.ok && first.body.clientId === second.body.clientId).toBe(true);
  });

  it('uses the chosen time instead of now', () => {
    const result = buildCreateBody(
      { ...filled(), occurredAt: '2026-10-16T07:30:00+03:00' },
      inspection,
      0,
      NOW,
    );
    expect(result.ok && result.body.occurredAt).toBe('2026-10-16T04:30:00.000Z');
  });

  it('refuses a time more than an hour in the future', () => {
    const result = buildCreateBody(
      { ...filled(), occurredAt: '2026-10-16T14:00:00Z' },
      inspection,
      0,
      NOW,
    );
    expect(result.ok === false && result.errors.occurredAt).toBe('future');
  });

  it('reports custom-field problems by key, with codes', () => {
    const result = buildCreateBody(
      {
        ...filled(),
        customFields: { area: '', count: 'twelve', passed: null, result: '', next: '' },
      },
      inspection,
      0,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.customFields).toEqual({
      area: { code: 'required', message: 'is required' },
      count: { code: 'number', message: 'must be a number' },
      passed: { code: 'required', message: 'is required' },
    });
  });

  it('refuses an empty log, but accepts a photo, a note or a type alone', () => {
    const empty = newLogFormValues(CLIENT_ID);
    const refused = buildCreateBody(empty, null, 0, NOW);
    expect(refused.ok === false && refused.errors.empty).toBe(true);
    expect(buildCreateBody(empty, null, 1, NOW).ok).toBe(true);
    expect(buildCreateBody({ ...empty, text: 'Note' }, null, 0, NOW).ok).toBe(true);
    const typeOnly = withLogType(empty, { ...delivery, fields: [] });
    expect(buildCreateBody(typeOnly, { ...delivery, fields: [] }, 0, NOW).ok).toBe(true);
  });

  it('sends empty custom fields and a null text for a plain photo log', () => {
    const result = buildCreateBody(newLogFormValues(CLIENT_ID), null, 2, NOW);
    expect(result.ok && result.body).toMatchObject({
      customFields: {},
      text: null,
      logTypeId: null,
    });
  });
});

describe('withLogType', () => {
  it('keeps values of fields the new type shares and empties the rest', () => {
    const switched = withLogType(filled(), delivery);
    expect(switched.logTypeId).toBe(delivery.id);
    expect(switched.customFields).toEqual({ area: 'Hall B', count: '12,5' });
    expect(withLogType(filled(), null).customFields).toEqual({});
  });
});

function savedLog(overrides: Partial<WorkLog> = {}): WorkLog {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    organizationId: inspection.organizationId,
    clientId: CLIENT_ID,
    authorId: '66666666-6666-4666-8666-666666666666',
    occurredAt: '2026-10-16T08:00:00.000Z',
    taskId: null,
    siteId: null,
    teamId: null,
    logTypeId: inspection.id,
    logTypeVersion: 3,
    text: 'Checked the north wall.',
    customFields: { area: 'Hall B', count: 12.5, passed: true, result: 'ok', next: '2026-11-01' },
    location: null,
    status: 'rejected',
    review: null,
    source: 'manual',
    aiMetadata: null,
    createdAt: '2026-10-16T08:05:00.000Z',
    updatedAt: '2026-10-16T08:05:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('buildUpdateBody', () => {
  it('sends nothing when nothing changed', () => {
    const log = savedLog();
    const result = buildUpdateBody(logFormValuesFromLog(log, inspection), log, inspection, 0, NOW);
    expect(result).toEqual({ ok: true, body: null });
  });

  it('sends only what changed, with the custom fields whole', () => {
    const log = savedLog();
    const values = logFormValuesFromLog(log, inspection);
    const result = buildUpdateBody(
      {
        ...values,
        text: 'Fixed the wall.',
        customFields: { ...values.customFields, result: 'defect' },
      },
      log,
      inspection,
      0,
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      body: {
        text: 'Fixed the wall.',
        customFields: {
          area: 'Hall B',
          count: 12.5,
          passed: true,
          result: 'defect',
          next: '2026-11-01',
        },
      },
    });
  });

  it('sends the new type and its fields when the type changes', () => {
    const log = savedLog();
    const values = withLogType(logFormValuesFromLog(log, inspection), delivery);
    const result = buildUpdateBody(
      { ...values, customFields: { ...values.customFields, count: '4' } },
      log,
      delivery,
      0,
      NOW,
    );
    expect(result.ok && result.body).toEqual({
      logTypeId: delivery.id,
      customFields: { area: 'Hall B', count: 4 },
    });
  });

  it('validates the edited fields like a new log', () => {
    const log = savedLog();
    const values = logFormValuesFromLog(log, inspection);
    const result = buildUpdateBody(
      { ...values, customFields: { ...values.customFields, area: ' ' } },
      log,
      inspection,
      0,
      NOW,
    );
    expect(result.ok === false && result.errors.customFields.area?.code).toBe('required');
  });
});

describe('when the log type changed since the form was filled (Phase 4 coverage)', () => {
  const inspectionV4: LogType = {
    ...inspection,
    version: 4,
    fields: customFieldDefinitionsSchema.parse([
      { key: 'area', label: 'Area', type: 'text', required: true },
      { key: 'count', label: 'Count', type: 'boolean' }, // was a number
      { key: 'passed', label: 'Passed', type: 'boolean', required: true },
      { key: 'shift', label: 'Shift', type: 'select', options: ['day', 'night'], required: true },
    ]),
  };

  it('a restored draft keeps what still fits, drops removed fields and asks for the new required one', () => {
    const restored = withLogType(filled(), inspectionV4);
    expect(restored.customFields).toEqual({ area: 'Hall B', count: null, passed: true, shift: '' });
    const result = buildCreateBody(restored, inspectionV4, 0, NOW);
    expect(result.ok === false && result.errors.customFields).toEqual({
      shift: { code: 'required', message: 'is required' },
    });
    const fixed = buildCreateBody(
      { ...restored, customFields: { ...restored.customFields, shift: 'night' } },
      inspectionV4,
      0,
      NOW,
    );
    expect(fixed.ok && fixed.body.customFields).toEqual({
      area: 'Hall B',
      passed: true,
      shift: 'night',
    });
  });

  it('editing a log whose stored values include a removed field sends the values without it', () => {
    const log = savedLog({
      customFields: { area: 'Hall B', count: 12.5, passed: true, shift: 'day', removed: 'x' },
    });
    const values = logFormValuesFromLog(log, inspectionV4);
    expect(values.customFields).not.toHaveProperty('removed');
    const result = buildUpdateBody(values, log, inspectionV4, 0, NOW);
    expect(result.ok && result.body).toEqual({
      customFields: { area: 'Hall B', passed: true, shift: 'day' },
    });
  });

  // BUG (reported): the edit form gets `logType = null` when the log's type is no longer in the
  // list the phone loads (archived types are not listed). A text-only edit then sends
  // `customFields: {}` (it differs from the stored values), which the API re-validates against the
  // type: 400 for required fields the phone cannot show, or optional values wiped.
  it('does not send custom fields it could not show (log type unavailable)', () => {
    const log = savedLog({ status: 'submitted' });
    const values = logFormValuesFromLog(log, null);
    const result = buildUpdateBody({ ...values, text: 'Corrected' }, log, null, 0, NOW);
    expect(result).toEqual({ ok: true, body: { text: 'Corrected' } });
  });
});

describe('server errors on the form', () => {
  it('puts a removed field, a bad option and a bad date on their fields, and a long text on text', () => {
    const errors = errorsFromApiDetails([
      { path: 'customFields.removed', message: 'is not a field of this log type' },
      { path: 'customFields.result', message: 'must be one of: ok, defect' },
      {
        path: 'customFields.next',
        message: 'must be an ISO date (YYYY-MM-DD) or an ISO datetime with an offset',
      },
      { path: 'text', message: 'must be at most 10000 characters' },
      { path: 'occurredAt', message: 'must be an ISO datetime with an offset' },
    ]);
    expect(
      Object.fromEntries(
        Object.entries(errors.customFields).map(([key, value]) => [key, value.code]),
      ),
    ).toEqual({ removed: 'unknownField', result: 'option', next: 'date' });
    expect(errors.text).toBe('tooLong');
    expect(errors.occurredAt).toBe('invalid');
    expect(errors.other).toEqual({});
  });
});

describe('errorsFromApiDetails', () => {
  it('puts server errors next to the right fields', () => {
    const errors = errorsFromApiDetails([
      { path: 'customFields.count', message: 'must be a number' },
      { path: 'occurredAt', message: 'must not be in the future' },
      { path: 'siteId', message: 'does not exist' },
    ]);
    expect(errors.customFields).toEqual({ count: { code: 'number', message: 'must be a number' } });
    expect(errors.occurredAt).toBe('future');
    expect(errors.other).toEqual({ siteId: 'does not exist' });
    expect(hasLogFormErrors(errors)).toBe(true);
    expect(hasLogFormErrors(errorsFromApiDetails([]))).toBe(false);
  });
});
