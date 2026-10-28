import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorCode } from '../common/errors.js';
import type { Attachment, AttachmentUpload } from '../domain/attachments.js';
import {
  isRetryableApiFailure,
  isTargetExpired,
  uploadAttachment,
  uploadRetryDelayMs,
  type AttachmentUploadApi,
  type UploadPut,
} from './attachment-upload.js';
import type { ApiFailure, ApiResult } from './client.js';

const NOW = new Date('2026-10-16T10:00:00Z');
const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111';
const LOG_ID = '22222222-2222-4222-8222-222222222222';
const FILE = { fileName: 'photo-1.jpg', mimeType: 'image/jpeg' as const, sizeBytes: 1234 };

function attachment(status: 'pending' | 'ready'): Attachment {
  return {
    id: ATTACHMENT_ID,
    organizationId: '33333333-3333-4333-8333-333333333333',
    workLogId: LOG_ID,
    uploadedById: '44444444-4444-4444-8444-444444444444',
    clientId: null,
    fileName: FILE.fileName,
    mimeType: FILE.mimeType,
    sizeBytes: FILE.sizeBytes,
    status,
    width: null,
    height: null,
    url: null,
    thumbnailUrl: null,
    urlsExpireAt: null,
    createdAt: NOW.toISOString(),
    completedAt: status === 'ready' ? NOW.toISOString() : null,
    archivedAt: null,
  };
}

function upload(expiresInMs = 600_000, url = 'https://storage.test/put-1'): AttachmentUpload {
  return {
    attachment: attachment('pending'),
    upload: {
      url,
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      expiresAt: new Date(NOW.getTime() + expiresInMs).toISOString(),
    },
  };
}

const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data });
const fail = (failure: ApiFailure): ApiResult<never> => ({ ok: false, failure });
const network: ApiFailure = { kind: 'network', message: 'Network request failed' };
function http(status: number, code: ApiErrorCode): ApiFailure {
  return {
    kind: 'http',
    status,
    message: `HTTP ${status}`,
    error: {
      statusCode: status,
      code,
      message: `HTTP ${status}`,
      correlationId: null,
      timestamp: NOW.toISOString(),
    },
  };
}

function fakeApi(overrides: Partial<AttachmentUploadApi> = {}) {
  return {
    startUpload: vi.fn(async () => ok(upload(), 201)),
    renewUpload: vi.fn(async () => ok(upload(600_000, 'https://storage.test/put-2'))),
    complete: vi.fn(async () => ok(attachment('ready'))),
    get: vi.fn(async () => ok(attachment('pending'))),
    ...overrides,
  } satisfies AttachmentUploadApi;
}

const putOk: UploadPut = async (_target, onProgress) => {
  onProgress(0.5);
  onProgress(1);
  return { ok: true };
};

const clock = () => NOW;

describe('uploadAttachment', () => {
  it('starts, puts with the returned headers, and completes', async () => {
    const api = fakeApi();
    const put = vi.fn(putOk);
    const progress: number[] = [];
    const result = await uploadAttachment(
      api,
      { workLogId: LOG_ID, file: FILE, put, onProgress: (p) => progress.push(p) },
      clock,
    );
    expect(result).toMatchObject({
      ok: true,
      attachment: { status: 'ready' },
      checkpoint: { attachmentId: ATTACHMENT_ID, stored: true },
    });
    expect(api.startUpload).toHaveBeenCalledWith(LOG_ID, FILE, {});
    expect(put.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://storage.test/put-1',
      headers: { 'Content-Type': 'image/jpeg' },
    });
    expect(api.complete).toHaveBeenCalledWith(ATTACHMENT_ID, {});
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('stops before any PUT when start fails, with nothing to resume', async () => {
    const api = fakeApi({ startUpload: vi.fn(async () => fail(network)) });
    const put = vi.fn(putOk);
    const result = await uploadAttachment(api, { workLogId: LOG_ID, file: FILE, put }, clock);
    expect(result).toMatchObject({
      ok: false,
      failure: { step: 'start', retryable: true },
      checkpoint: { attachmentId: null, stored: false },
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('marks a refused start (422) as not retryable', async () => {
    const api = fakeApi({ startUpload: vi.fn(async () => fail(http(422, 'unprocessable'))) });
    const result = await uploadAttachment(
      api,
      { workLogId: LOG_ID, file: FILE, put: putOk },
      clock,
    );
    expect(result).toMatchObject({ ok: false, failure: { step: 'start', retryable: false } });
  });

  it('keeps the attachment id when the PUT fails, and a retry renews instead of starting again', async () => {
    const api = fakeApi();
    const first = await uploadAttachment(
      api,
      {
        workLogId: LOG_ID,
        file: FILE,
        put: async () => ({ ok: false, status: 0, message: 'offline' }),
      },
      clock,
    );
    expect(first).toMatchObject({
      ok: false,
      failure: { step: 'put', retryable: true, putStatus: 0 },
      checkpoint: { attachmentId: ATTACHMENT_ID, stored: false },
    });

    const put = vi.fn(putOk);
    const second = await uploadAttachment(
      api,
      { workLogId: LOG_ID, file: FILE, put, checkpoint: first.checkpoint },
      clock,
    );
    expect(second.ok).toBe(true);
    expect(api.startUpload).toHaveBeenCalledTimes(1);
    expect(api.renewUpload).toHaveBeenCalledWith(ATTACHMENT_ID, {});
    expect(put.mock.calls[0]?.[0].url).toBe('https://storage.test/put-2');
  });

  it('renews once and resends when the storage refuses an expired URL (403)', async () => {
    const api = fakeApi();
    const put = vi
      .fn<UploadPut>()
      .mockResolvedValueOnce({ ok: false, status: 403, message: 'Request has expired' })
      .mockResolvedValueOnce({ ok: true });
    const result = await uploadAttachment(api, { workLogId: LOG_ID, file: FILE, put }, clock);
    expect(result.ok).toBe(true);
    expect(api.renewUpload).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]?.[0].url).toBe('https://storage.test/put-2');
  });

  it('does not loop when the renewed URL is refused too', async () => {
    const api = fakeApi();
    const put = vi.fn<UploadPut>(async () => ({ ok: false, status: 403, message: 'Forbidden' }));
    const result = await uploadAttachment(api, { workLogId: LOG_ID, file: FILE, put }, clock);
    expect(result).toMatchObject({ ok: false, failure: { step: 'put', putStatus: 403 } });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('renews a URL that is already expired before sending the bytes', async () => {
    const api = fakeApi({ startUpload: vi.fn(async () => ok(upload(-1000), 201)) });
    const put = vi.fn(putOk);
    const result = await uploadAttachment(api, { workLogId: LOG_ID, file: FILE, put }, clock);
    expect(result.ok).toBe(true);
    expect(api.renewUpload).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0].url).toBe('https://storage.test/put-2');
  });

  it('only calls complete on a retry after the bytes were stored', async () => {
    const api = fakeApi({
      complete: vi
        .fn<AttachmentUploadApi['complete']>()
        .mockResolvedValueOnce(fail({ kind: 'timeout', message: 'slow' }))
        .mockResolvedValueOnce(ok(attachment('ready'))),
    });
    const put = vi.fn(putOk);
    const first = await uploadAttachment(api, { workLogId: LOG_ID, file: FILE, put }, clock);
    expect(first).toMatchObject({
      ok: false,
      failure: { step: 'complete', retryable: true },
      checkpoint: { stored: true },
    });
    const second = await uploadAttachment(
      api,
      { workLogId: LOG_ID, file: FILE, put, checkpoint: first.checkpoint },
      clock,
    );
    expect(second.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(api.renewUpload).not.toHaveBeenCalled();
  });

  it('sends the bytes again when complete says they are missing', async () => {
    const api = fakeApi({
      complete: vi
        .fn<AttachmentUploadApi['complete']>()
        .mockResolvedValueOnce(fail(http(422, 'unprocessable')))
        .mockResolvedValueOnce(ok(attachment('ready'))),
    });
    const put = vi.fn(putOk);
    const result = await uploadAttachment(
      api,
      {
        workLogId: LOG_ID,
        file: FILE,
        put,
        checkpoint: { attachmentId: ATTACHMENT_ID, stored: true },
      },
      clock,
    );
    expect(result.ok).toBe(true);
    expect(api.renewUpload).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('treats a 409 from complete (bytes not arrived) as retryable, sending the bytes again', async () => {
    const api = fakeApi({
      complete: vi
        .fn<AttachmentUploadApi['complete']>()
        .mockResolvedValueOnce(fail(http(409, 'conflict')))
        .mockResolvedValueOnce(ok(attachment('ready'))),
    });
    const put = vi.fn(putOk);
    const first = await uploadAttachment(api, { workLogId: LOG_ID, file: FILE, put }, clock);
    expect(first).toMatchObject({
      ok: false,
      failure: { step: 'complete', retryable: true },
      checkpoint: { attachmentId: ATTACHMENT_ID, stored: false },
    });
    const second = await uploadAttachment(
      api,
      { workLogId: LOG_ID, file: FILE, put, checkpoint: first.checkpoint },
      clock,
    );
    expect(second.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('treats a 409 on renew as done when the attachment is already ready', async () => {
    const api = fakeApi({
      renewUpload: vi.fn(async () => fail(http(409, 'conflict'))),
      get: vi.fn(async () => ok(attachment('ready'))),
    });
    const put = vi.fn(putOk);
    const result = await uploadAttachment(
      api,
      {
        workLogId: LOG_ID,
        file: FILE,
        put,
        checkpoint: { attachmentId: ATTACHMENT_ID, stored: false },
      },
      clock,
    );
    expect(result).toMatchObject({ ok: true, attachment: { status: 'ready' } });
    expect(put).not.toHaveBeenCalled();
  });

  it('reports a 409 on renew of a pending attachment as a failure', async () => {
    const api = fakeApi({ renewUpload: vi.fn(async () => fail(http(409, 'conflict'))) });
    const result = await uploadAttachment(
      api,
      {
        workLogId: LOG_ID,
        file: FILE,
        put: putOk,
        checkpoint: { attachmentId: ATTACHMENT_ID, stored: false },
      },
      clock,
    );
    expect(result).toMatchObject({ ok: false, failure: { step: 'renew', retryable: false } });
  });
});

describe('uploadAttachment with a clientId (offline sync)', () => {
  const OPTIONS = { headers: { 'x-client-sync': 'offline' } };

  it('passes the request options to every API call', async () => {
    const api = fakeApi();
    await uploadAttachment(
      api,
      { workLogId: LOG_ID, file: FILE, put: putOk, requestOptions: OPTIONS },
      clock,
    );
    expect(api.startUpload).toHaveBeenCalledWith(LOG_ID, FILE, OPTIONS);
    expect(api.complete).toHaveBeenCalledWith(ATTACHMENT_ID, OPTIONS);
  });

  it('succeeds without a PUT when a repeated start finds the photo already ready', async () => {
    const api = fakeApi({
      startUpload: vi.fn(async () => ok({ attachment: attachment('ready'), upload: null })),
    });
    const put = vi.fn(putOk);
    const result = await uploadAttachment(api, { workLogId: LOG_ID, file: FILE, put }, clock);
    expect(result).toMatchObject({
      ok: true,
      checkpoint: { attachmentId: ATTACHMENT_ID, stored: true },
    });
    expect(put).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('does not resend the bytes when complete answers a final 409 code', async () => {
    const api = fakeApi({ complete: vi.fn(async () => fail(http(409, 'record_archived'))) });
    const result = await uploadAttachment(
      api,
      { workLogId: LOG_ID, file: FILE, put: putOk },
      clock,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { step: 'complete', retryable: false },
      checkpoint: { stored: true },
    });
  });
});

describe('isRetryableApiFailure', () => {
  it.each([
    [network, true],
    [{ kind: 'timeout', message: 'x' } as ApiFailure, true],
    [http(500, 'internal_error'), true],
    [http(409, 'conflict'), false],
    [http(422, 'unprocessable'), false],
    [http(409, 'request_in_progress'), true],
    [http(409, 'version_conflict'), false],
    [http(403, 'edit_window_closed'), false],
    [{ kind: 'invalid-response', status: 502, message: 'x' } as ApiFailure, true],
    [{ kind: 'invalid-response', status: 200, message: 'x' } as ApiFailure, false],
  ])('%#', (failure, expected) => {
    expect(isRetryableApiFailure(failure)).toBe(expected);
  });
});

describe('isTargetExpired', () => {
  it('counts a URL that expires within the margin as expired', () => {
    expect(isTargetExpired(upload(10_000).upload, NOW)).toBe(true);
    expect(isTargetExpired(upload(60_000).upload, NOW)).toBe(false);
  });
});

describe('uploadRetryDelayMs', () => {
  it('doubles from two seconds and stops after the last automatic attempt', () => {
    const noJitter = { random: () => 0 };
    expect(uploadRetryDelayMs(1, noJitter)).toBe(2000);
    expect(uploadRetryDelayMs(2, noJitter)).toBe(4000);
    expect(uploadRetryDelayMs(3, noJitter)).toBe(8000);
    expect(uploadRetryDelayMs(4, noJitter)).toBeNull();
    expect(uploadRetryDelayMs(0, noJitter)).toBeNull();
  });

  it('caps the delay and adds at most 20% jitter', () => {
    expect(uploadRetryDelayMs(6, { maxAttempts: 10, random: () => 0 })).toBe(30_000);
    expect(uploadRetryDelayMs(1, { random: () => 0.999 })).toBeLessThanOrEqual(2400);
  });
});
