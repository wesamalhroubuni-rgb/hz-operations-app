import { AUDIT_REDACTED } from '@ops/shared';
import {
  DEFAULT_REDACTED_KEY_PATTERN,
  diffSnapshots,
  redactSnapshot,
  toJsonSnapshot,
} from './audit/audit-snapshot';
import { AuditService, type AuditWriter } from './audit/audit.service';
import { dateRangeFilter, escapeLike, nameFilter } from './http/filters';
import {
  clampBatchSize,
  OutboxService,
  type OutboxMarker,
  type OutboxWriter,
} from './outbox/outbox.service';
import { resolveCorrelationId, sanitizeCorrelationId } from './request-context/correlation-id';
import { RequestContext } from './request-context/request-context';
import { formatRequestLog, isQuietPath, pathOf } from './request-context/request-log';

// Smoke tests of the pure platform logic. The thorough suites live with the test-writer.

describe('correlation id', () => {
  it('keeps a sane caller value', () => {
    expect(sanitizeCorrelationId('abc-123_x.y:z')).toBe('abc-123_x.y:z');
    expect(sanitizeCorrelationId('  0190f3a2-7c1e-7000-8000-000000000001 ')).toBe(
      '0190f3a2-7c1e-7000-8000-000000000001',
    );
  });

  it('rejects values that are empty, too long, repeated, or carry unsafe characters', () => {
    expect(sanitizeCorrelationId(undefined)).toBeNull();
    expect(sanitizeCorrelationId('')).toBeNull();
    expect(sanitizeCorrelationId('a'.repeat(65))).toBeNull();
    expect(sanitizeCorrelationId(['a', 'b'])).toBeNull();
    expect(sanitizeCorrelationId('a b')).toBeNull();
    expect(sanitizeCorrelationId('a\r\nSet-Cookie: x=1')).toBeNull();
    expect(sanitizeCorrelationId('{"a":1}')).toBeNull();
  });

  it('generates a UUID when the caller value is unusable', () => {
    expect(resolveCorrelationId('ok-1')).toBe('ok-1');
    expect(resolveCorrelationId('<script>')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('request log', () => {
  it('drops the query string from the path', () => {
    expect(pathOf('/users?email=someone@example.com')).toBe('/users');
    expect(pathOf('/users/1#x')).toBe('/users/1');
    expect(pathOf(undefined)).toBe('/');
  });

  it('recognises quiet paths and what lies below them', () => {
    expect(isQuietPath('/health', ['/health', '/docs'])).toBe(true);
    expect(isQuietPath('/docs/swagger-ui.css', ['/health', '/docs'])).toBe(true);
    expect(isQuietPath('/healthy', ['/health', '/docs'])).toBe(false);
  });

  it('writes one single-line JSON object', () => {
    const line = formatRequestLog({
      method: 'GET',
      path: '/sites',
      status: 200,
      durationMs: 12,
      correlationId: 'c-1',
      actorId: null,
    });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      msg: 'request',
      method: 'GET',
      path: '/sites',
      status: 200,
      durationMs: 12,
      correlationId: 'c-1',
      actorId: null,
    });
  });
});

describe('audit snapshot', () => {
  const rules = { pattern: DEFAULT_REDACTED_KEY_PATTERN, keys: ['pin'] };

  it('makes JSON-safe copies', () => {
    expect(
      toJsonSnapshot({ at: new Date('2026-10-13T10:00:00.000Z'), n: 5n, skip: undefined }),
    ).toEqual({ at: '2026-10-13T10:00:00.000Z', n: '5' });
    expect(toJsonSnapshot(null)).toBeUndefined();
  });

  it('diffs top-level fields with deep equality', () => {
    expect(
      diffSnapshots(
        { name: 'A', tags: ['x'], meta: { a: 1, b: 2 }, gone: 1 },
        { name: 'B', tags: ['x'], meta: { b: 2, a: 1 }, added: true },
      ),
    ).toEqual({
      name: { from: 'A', to: 'B' },
      gone: { from: 1, to: null },
      added: { from: null, to: true },
    });
    expect(diffSnapshots({ a: 1 }, { a: 1 })).toEqual({});
    expect(diffSnapshots(undefined, { a: 1 })).toBeNull();
    expect(diffSnapshots({ a: 1 }, undefined)).toBeNull();
  });

  it('redacts sensitive keys at any depth', () => {
    expect(
      redactSnapshot(
        {
          email: 'a@b.c',
          passwordHash: 'x',
          PIN: '1234',
          nested: [{ refreshToken: 't', ok: 1 }],
        },
        rules,
      ),
    ).toEqual({
      email: 'a@b.c',
      passwordHash: AUDIT_REDACTED,
      PIN: AUDIT_REDACTED,
      nested: [{ refreshToken: AUDIT_REDACTED, ok: 1 }],
    });
  });
});

describe('AuditService.record', () => {
  function fakeTx() {
    const create = jest.fn().mockResolvedValue({});
    const tx: AuditWriter = { auditEvent: { create } };
    return { tx, create };
  }

  it('writes one row with the diff, the actor and the correlation id', async () => {
    const { tx, create } = fakeTx();
    await RequestContext.run(
      { correlationId: 'c-1', actor: { userId: 'u-1', organizationId: 'o-1' } },
      () =>
        new AuditService().record(tx, {
          organizationId: 'o-1',
          action: 'thing.updated',
          entityType: 'thing',
          entityId: 't-1',
          before: { name: 'A', password: 'old' },
          after: { name: 'B', password: 'new' },
        }),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: 'o-1',
        actorType: 'user',
        actorId: 'u-1',
        action: 'thing.updated',
        entityType: 'thing',
        entityId: 't-1',
        before: { name: 'A', password: AUDIT_REDACTED },
        after: { name: 'B', password: AUDIT_REDACTED },
        changes: {
          name: { from: 'A', to: 'B' },
          password: { from: AUDIT_REDACTED, to: AUDIT_REDACTED },
        },
        correlationId: 'c-1',
      },
    });
  });

  it('attributes a write outside a request to the system and leaves changes out on create', async () => {
    const { tx, create } = fakeTx();
    await new AuditService().record(tx, {
      organizationId: null,
      action: 'thing.created',
      entityType: 'thing',
      entityId: 't-1',
      after: { name: 'A' },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: null,
        actorType: 'system',
        actorId: null,
        action: 'thing.created',
        entityType: 'thing',
        entityId: 't-1',
        after: { name: 'A' },
        correlationId: null,
      },
    });
  });
});

describe('OutboxService', () => {
  it('clamps the batch size', () => {
    expect(clampBatchSize(undefined)).toBe(100);
    expect(clampBatchSize(0)).toBe(1);
    expect(clampBatchSize(10_000)).toBe(500);
    expect(clampBatchSize(Number.NaN)).toBe(100);
  });

  it('marks only events that are not marked yet', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const db: OutboxMarker = { outboxEvent: { updateMany } };
    const at = new Date('2026-10-13T10:00:00.000Z');
    const service = new OutboxService();

    await expect(service.markProcessed(db, [1n, 2n], at)).resolves.toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { sequence: { in: [1n, 2n] }, processedAt: null },
      data: { processedAt: at },
    });
    await expect(service.markProcessed(db, [])).resolves.toBe(0);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  function fakeWriter() {
    const create = jest.fn().mockResolvedValue({});
    const tx: OutboxWriter = { outboxEvent: { create } };
    return { tx, create };
  }

  it('publishes one row with the actor and the correlation id of the request', async () => {
    const { tx, create } = fakeWriter();
    await RequestContext.run(
      { correlationId: 'c-1', actor: { userId: 'u-1', organizationId: 'o-1' } },
      () =>
        new OutboxService().publish(tx, {
          organizationId: 'o-1',
          eventType: 'thing.created',
          aggregateType: 'thing',
          aggregateId: 't-1',
          payload: { thing: { name: 'A', at: new Date('2026-10-13T10:00:00.000Z'), n: 5n } },
        }),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: 'o-1',
        eventType: 'thing.created',
        aggregateType: 'thing',
        aggregateId: 't-1',
        payload: { thing: { name: 'A', at: '2026-10-13T10:00:00.000Z', n: '5' } },
        actorId: 'u-1',
        correlationId: 'c-1',
      },
    });
  });

  it('redacts sensitive keys of the payload at any depth, like the audit log', async () => {
    const { tx, create } = fakeWriter();
    await new OutboxService().publish(tx, {
      organizationId: null,
      eventType: 'thing.updated',
      aggregateType: 'thing',
      aggregateId: 't-1',
      payload: {
        from: 'draft',
        token: 'top-level',
        thing: {
          email: 'a@b.c',
          passwordHash: 'x',
          settings: { apiKey: 'k', api_key: 'k2', timezone: 'UTC' },
          sessions: [{ refreshToken: 't', device: 'phone' }],
          Authorization: 'Bearer x',
          clientSecret: 's',
          tokens: 3,
        },
      },
    });
    expect(create.mock.calls[0]?.[0].data).toEqual({
      organizationId: null,
      eventType: 'thing.updated',
      aggregateType: 'thing',
      aggregateId: 't-1',
      payload: {
        from: 'draft',
        token: AUDIT_REDACTED,
        thing: {
          email: 'a@b.c',
          passwordHash: AUDIT_REDACTED,
          settings: { apiKey: AUDIT_REDACTED, api_key: AUDIT_REDACTED, timezone: 'UTC' },
          sessions: [{ refreshToken: AUDIT_REDACTED, device: 'phone' }],
          Authorization: AUDIT_REDACTED,
          clientSecret: AUDIT_REDACTED,
          tokens: AUDIT_REDACTED,
        },
      },
      actorId: null,
      correlationId: null,
    });
  });

  it('does not change the payload object it was given', async () => {
    const { tx } = fakeWriter();
    const payload = { thing: { password: 'p', name: 'A' } };
    await new OutboxService().publish(tx, {
      organizationId: null,
      eventType: 'thing.created',
      aggregateType: 'thing',
      aggregateId: 't-1',
      payload,
    });
    expect(payload).toEqual({ thing: { password: 'p', name: 'A' } });
  });

  it('stores an empty object for a missing payload', async () => {
    const { tx, create } = fakeWriter();
    await new OutboxService().publish(tx, {
      organizationId: null,
      eventType: 'thing.created',
      aggregateType: 'thing',
      aggregateId: 't-1',
      payload: undefined,
    });
    expect(create.mock.calls[0]?.[0].data.payload).toEqual({});
  });
});

describe('list filters', () => {
  it('treats a trailing dot or asterisk as a prefix', () => {
    expect(nameFilter('task.created')).toEqual({ equals: 'task.created' });
    expect(nameFilter('task.')).toEqual({ startsWith: 'task.' });
    expect(nameFilter('task.*')).toEqual({ startsWith: 'task.' });
    expect(nameFilter(undefined)).toBeUndefined();
    expect(nameFilter('')).toBeUndefined();
  });

  it('escapes LIKE wildcards in a prefix and leaves an exact name as it is', () => {
    expect(nameFilter('task_*')).toEqual({ startsWith: 'task\\_' });
    expect(nameFilter('t%k.')).toEqual({ startsWith: 't\\%k.' });
    expect(nameFilter('a\\b.*')).toEqual({ startsWith: 'a\\\\b.' });
    expect(nameFilter('*')).toEqual({ startsWith: '' });
    // `equals` is not a pattern, so nothing is escaped there.
    expect(nameFilter('task_list%')).toEqual({ equals: 'task_list%' });
  });

  it('escapes %, _ and the backslash itself, and nothing else', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('snake_case')).toBe('snake\\_case');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
    expect(escapeLike("plain text. *[]^$' ok")).toBe("plain text. *[]^$' ok");
    expect(escapeLike('')).toBe('');
  });

  it('builds a date range with an inclusive from and an exclusive to', () => {
    const from = '2026-10-01T00:00:00Z';
    const to = '2026-11-01T00:00:00+03:00';
    expect(dateRangeFilter(undefined, undefined)).toBeUndefined();
    expect(dateRangeFilter(from, undefined)).toEqual({ gte: new Date(from) });
    expect(dateRangeFilter(undefined, to)).toEqual({ lt: new Date(to) });
    expect(dateRangeFilter(from, to)).toEqual({ gte: new Date(from), lt: new Date(to) });
    expect(dateRangeFilter(from, to)).not.toHaveProperty('lte');
  });
});
