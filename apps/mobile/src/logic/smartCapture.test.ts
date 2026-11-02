import type { LogType, SmartCapture } from '@ops/shared';

import { captureFixture } from '../offline/engineTestKit';
import type { LocalSmartCapture, QueueItem } from '../offline/types';
import { newLogFormValues } from './logForm';
import {
  captureState,
  confidenceHints,
  confirmationBody,
  formValuesFromCapture,
  recordingProgress,
  transcriptOf,
} from './smartCapture';

const LOG_TYPE = {
  id: 'lt-1',
  key: 'inspection',
  name: 'Inspection',
  fields: [
    { key: 'area', label: 'Area', type: 'text', required: true },
    { key: 'passed', label: 'Passed', type: 'boolean', required: false },
  ],
} as unknown as LogType;

function local(capture: SmartCapture | null, text = 'Roof done'): LocalSmartCapture {
  return {
    captureClientId: 'cap-client-1',
    input: { kind: 'text', text },
    context: {
      taskId: 'task-ctx',
      siteId: null,
      logTypeId: null,
      capturedAt: '2026-10-27T09:00:00.000Z',
      languageHint: 'en',
    },
    capture,
    createdAt: '2026-10-27T09:00:00.000Z',
  };
}

const proposed = captureFixture({
  id: 'cap-1',
  status: 'proposed',
  transcript: 'Roof done, area north',
  proposal: {
    logTypeId: 'lt-1',
    taskId: 'task-1',
    siteId: 'site-1',
    text: 'Roof checked',
    customFields: { area: 'North', passed: true },
    occurredAt: '2026-10-27T08:00:00.000Z',
  },
  confidence: {
    logType: 'high',
    task: 'medium',
    site: 'low',
    text: 'high',
    customFields: { area: 'high', passed: 'low' },
  },
});

const item = (state: QueueItem['state'], code?: string): QueueItem =>
  ({
    state,
    lastError: code ? { code, message: code, status: 403 } : null,
  }) as unknown as QueueItem;

describe('smart capture review logic', () => {
  it('derives the state from the result and the queue item', () => {
    expect(captureState(local(proposed), null)).toEqual({ kind: 'ready' });
    expect(captureState(local(captureFixture({ status: 'failed' })), null)).toEqual({
      kind: 'notUnderstood',
    });
    // A provider that rejected the request: the same "couldn't understand, fill in by hand".
    expect(
      captureState(
        local(captureFixture({ status: 'failed', failureReason: 'provider_rejected' })),
        null,
      ),
    ).toEqual({ kind: 'notUnderstood' });
    expect(captureState(local(null), item('pending'))).toEqual({
      kind: 'waiting',
      retrying: false,
    });
    expect(captureState(local(null), item('failed_retryable'))).toEqual({
      kind: 'waiting',
      retrying: true,
    });
    expect(captureState(local(null), item('failed_permanent', 'ai_disabled'))).toMatchObject({
      kind: 'notProcessed',
      reason: { code: 'ai_disabled' },
    });
  });

  it('fills the form from the proposal', () => {
    const values = formValuesFromCapture(local(proposed), LOG_TYPE, newLogFormValues('log-1'));
    expect(values).toMatchObject({
      clientId: 'log-1',
      logTypeId: 'lt-1',
      customFields: { area: 'North', passed: true },
      text: 'Roof checked',
      taskId: 'task-1',
      siteId: 'site-1',
      occurredAt: '2026-10-27T08:00:00.000Z',
    });
  });

  it('fills the notes with the worker’s words when nothing was understood', () => {
    const failed = captureFixture({ status: 'failed', transcript: 'mumble' });
    const values = formValuesFromCapture(local(failed), null, newLogFormValues('log-1'));
    expect(values).toMatchObject({ text: 'mumble', taskId: 'task-ctx', logTypeId: null });
    expect(transcriptOf(local(null, 'typed'))).toBe('typed');
  });

  it('shows a hint only while a field keeps the suggestion', () => {
    const start = formValuesFromCapture(local(proposed), LOG_TYPE, newLogFormValues('log-1'));
    expect(confidenceHints(local(proposed), start, start)).toEqual({
      logTypeId: 'high',
      taskId: 'medium',
      siteId: 'low',
      text: 'high',
      'customFields.area': 'high',
      'customFields.passed': 'low',
    });
    const edited = {
      ...start,
      text: 'My own words',
      customFields: { ...start.customFields, area: 'South' },
    };
    const hints = confidenceHints(local(proposed), start, edited);
    expect(hints.text).toBeUndefined();
    expect(hints['customFields.area']).toBeUndefined();
    expect(hints['customFields.passed']).toBe('low');
    expect(confidenceHints(local(null), start, start)).toEqual({});
  });

  it('confirms as ai_assisted only when the server processed the capture', () => {
    const body = { clientId: 'log-1', occurredAt: '2026-10-27T08:00:00.000Z' };
    expect(confirmationBody(local(proposed), body)).toMatchObject({
      source: 'ai_assisted',
      aiProposalId: 'cap-1',
    });
    const manual = confirmationBody(local(null), { ...body, aiProposalId: 'x' });
    expect(manual.source).toBe('manual');
    expect('aiProposalId' in manual).toBe(false);
  });

  it('counts the recording time up to the limit', () => {
    expect(recordingProgress(61_500, 120_000)).toEqual({
      elapsedSeconds: 61,
      remainingSeconds: 59,
      reachedMax: false,
    });
    expect(recordingProgress(125_000, 120_000).reachedMax).toBe(true);
  });
});
