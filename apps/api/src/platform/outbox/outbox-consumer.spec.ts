import { RequestContext } from '../request-context/request-context';
import { ConsumerState, matchesEventPattern, type ConsumerPolicy } from './outbox-consumer-state';
import { OutboxConsumer, type OutboxConsumerOptions } from './outbox-consumer';
import { OutboxService, type OutboxEventRow } from './outbox.service';
import type { PrismaService } from '../../prisma/prisma.service';

// The consumer's ordering, late-commit, retry and idempotency rules. No database: a fake
// outbox table whose rows can be "committed" in any order. Example values only.

const POLICY: ConsumerPolicy = {
  settleMs: 1000,
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 400,
};

describe('ConsumerState', () => {
  it('advances the cursor only over events that are done AND settled', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([1n, 2n], 0);
    state.markDone(1n);
    state.markDone(2n);
    expect(state.advance(999)).toBeNull();
    expect(state.advance(1000)).toBe(2n);
    expect(state.cursor).toBe(2n);
    expect(state.trackedCount).toBe(0);
  });

  it('does not pass a lower sequence that commits late (the gap is waited out, not skipped)', () => {
    const state = new ConsumerState(0n, POLICY);
    // 11 is visible, 10 is still in an open transaction.
    state.observe([11n], 0);
    state.markDone(11n);
    // 10 commits before 11 settles: it is read in the re-scan and handled.
    state.observe([10n, 11n], 500);
    expect(state.isDue(10n, 500)).toBe(true);
    expect(state.isDue(11n, 500)).toBe(false);
    state.markDone(10n);
    // 10 was first seen at 500: the cursor waits for it, then passes both.
    expect(state.advance(1200)).toBeNull();
    expect(state.advance(1500)).toBe(11n);
  });

  it('passes a permanent gap (rolled-back transaction) once the next event has settled', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([3n], 0);
    state.markDone(3n);
    expect(state.advance(1000)).toBe(3n);
  });

  it('never handles an event twice while it is tracked', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([1n], 0);
    state.markDone(1n);
    state.observe([1n], 10);
    expect(state.isDue(1n, 10)).toBe(false);
  });

  it('ignores events at or below the cursor', () => {
    const state = new ConsumerState(5n, POLICY);
    state.observe([4n, 5n], 0);
    expect(state.trackedCount).toBe(0);
    expect(state.isDue(5n, 0)).toBe(false);
  });

  it('retries with exponential backoff, then gives up and lets the cursor pass', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([1n, 2n], 0);
    state.markDone(2n);
    expect(state.attemptFailed(1n, 0)).toEqual({ kind: 'retry', attempts: 1, retryAt: 100 });
    expect(state.isDue(1n, 99)).toBe(false);
    expect(state.isDue(1n, 100)).toBe(true);
    // A failing event holds the cursor.
    expect(state.advance(5000)).toBeNull();
    expect(state.attemptFailed(1n, 100)).toEqual({ kind: 'retry', attempts: 2, retryAt: 300 });
    expect(state.attemptFailed(1n, 300)).toEqual({ kind: 'give_up', attempts: 3 });
    expect(state.isDue(1n, 10_000)).toBe(false);
    expect(state.advance(5000)).toBe(2n);
  });

  it('caps the retry delay', () => {
    const state = new ConsumerState(0n, { ...POLICY, maxAttempts: 10 });
    state.observe([1n], 0);
    const delays = [1, 2, 3, 4, 5].map(() => {
      const outcome = state.attemptFailed(1n, 0);
      return outcome.kind === 'retry' ? outcome.retryAt : -1;
    });
    expect(delays).toEqual([100, 200, 400, 400, 400]);
  });

  it('lets the cursor pass a given-up event only once it has settled too', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([1n], 0);
    state.attemptFailed(1n, 0);
    state.attemptFailed(1n, 100);
    expect(state.attemptFailed(1n, 300)).toEqual({ kind: 'give_up', attempts: 3 });
    expect(state.advance(999)).toBeNull();
    expect(state.advance(1000)).toBe(1n);
  });

  it('stops at the first unsettled event: a newer event seen later holds the cursor after older ones', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([1n, 2n], 0);
    state.observe([3n], 800);
    [1n, 2n, 3n].forEach((sequence) => state.markDone(sequence));
    expect(state.advance(1000)).toBe(2n);
    expect(state.trackedCount).toBe(1);
    expect(state.advance(1799)).toBeNull();
    expect(state.advance(1800)).toBe(3n);
  });

  it('counts the settle time from when an event was FIRST seen, not from later re-reads', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([5n], 0);
    state.markDone(5n);
    state.observe([5n], 900); // the re-scan of the window sees it again
    expect(state.advance(1000)).toBe(5n);
  });

  it('a failing event holds the cursor while later events are handled and settle behind it', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([1n, 2n, 3n], 0);
    state.attemptFailed(1n, 0);
    state.markDone(2n);
    state.markDone(3n);
    expect(state.advance(5000)).toBeNull();
    expect(state.isDue(2n, 5000)).toBe(false);
    state.markDone(1n); // the retry succeeded
    expect(state.advance(5000)).toBe(3n);
  });

  it('after a read that hit its limit, reads on after the high water mark; after one that reached the end, from the cursor', () => {
    const state = new ConsumerState(0n, POLICY);
    expect([state.readAfter, state.readingFromCursor]).toEqual([0n, true]);
    state.observe([1n, 2n], 0);
    state.windowRead(false); // the read stopped at its limit
    expect([state.highWater, state.readAfter, state.readingFromCursor]).toEqual([2n, 2n, false]);
    state.observe([3n, 4n], 0);
    state.windowRead(false);
    expect(state.readAfter).toBe(4n);
    state.observe([5n], 0);
    state.windowRead(true); // reached the end: back to re-scanning the window from the cursor
    expect([state.readAfter, state.readingFromCursor, state.highWater]).toEqual([0n, true, 5n]);
    // Re-reading lower sequences never lowers the high water mark.
    state.observe([1n, 2n], 10);
    state.windowRead(false);
    expect(state.readAfter).toBe(5n);
  });

  it('advance(now, upTo) never moves the cursor past what the read from the cursor covered', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([1n, 2n, 5n], 0);
    [1n, 2n, 5n].forEach((sequence) => state.markDone(sequence));
    // 3 and 4 may still commit late: a read that only covered up to 2 may not pass them.
    expect(state.advance(5000, 2n)).toBe(2n);
    expect(state.trackedCount).toBe(1);
    expect(state.advance(5000)).toBe(5n);
  });

  it('remembers which handlers already succeeded', () => {
    const state = new ConsumerState(0n, POLICY);
    state.observe([1n], 0);
    state.handlerSucceeded(1n, 'a');
    expect(state.hasSucceeded(1n, 'a')).toBe(true);
    expect(state.hasSucceeded(1n, 'b')).toBe(false);
  });
});

describe('matchesEventPattern', () => {
  it.each([
    ['task.created', 'task.created', true],
    ['task.created', 'task.created_x', false],
    ['task.', 'task.created', true],
    ['task.', 'tasks.created', false],
    ['task.*', 'task.archived', true],
    ['work_log*', 'work_log.status_changed', true],
    ['*', 'anything', true],
    ['task.created', 'work_log.created', false],
  ])('%s matches %s: %s', (pattern, eventType, expected) => {
    expect(matchesEventPattern(pattern, eventType)).toBe(expected);
  });
});

/** A fake outbox table and cursor table. `visible` rows are the committed ones. */
function fakeDatabase() {
  const visible: OutboxEventRow[] = [];
  const cursors = new Map<string, bigint>();
  const processed = new Set<bigint>();
  const db = {
    outboxEvent: {
      findMany: jest.fn(
        (args: { where: { sequence: { gt: bigint } }; take: number }): Promise<OutboxEventRow[]> =>
          Promise.resolve(
            visible
              .filter((row) => row.sequence > args.where.sequence.gt)
              .sort((a, b) => (a.sequence < b.sequence ? -1 : 1))
              .slice(0, args.take),
          ),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve(
          visible.length === 0
            ? null
            : {
                sequence: visible.reduce(
                  (max, row) => (row.sequence > max ? row.sequence : max),
                  0n,
                ),
              },
        ),
      ),
      updateMany: jest.fn((args: { where: { sequence: { in: bigint[] } } }) => {
        args.where.sequence.in.forEach((sequence) => processed.add(sequence));
        return Promise.resolve({ count: args.where.sequence.in.length });
      }),
    },
    outboxConsumerCursor: {
      findUnique: jest.fn(({ where }: { where: { consumer: string } }) =>
        Promise.resolve(
          cursors.has(where.consumer)
            ? { consumer: where.consumer, lastSequence: cursors.get(where.consumer)! }
            : null,
        ),
      ),
      upsert: jest.fn(
        ({ where, create }: { where: { consumer: string }; create: { lastSequence: bigint } }) => {
          if (!cursors.has(where.consumer)) {
            cursors.set(where.consumer, create.lastSequence);
          }
          return Promise.resolve({
            consumer: where.consumer,
            lastSequence: cursors.get(where.consumer)!,
          });
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { consumer: string; lastSequence: { lt: bigint } };
          data: { lastSequence: bigint };
        }) => {
          const current = cursors.get(where.consumer) ?? 0n;
          if (current < where.lastSequence.lt) {
            cursors.set(where.consumer, data.lastSequence);
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        },
      ),
    },
  };
  const commit = (sequence: bigint, eventType = 'task.created') =>
    visible.push({
      id: `event-${sequence}`,
      sequence,
      organizationId: 'org',
      eventType,
      aggregateType: 'task',
      aggregateId: 'task',
      payload: {},
      actorId: null,
      correlationId: `corr-${sequence}`,
      occurredAt: new Date(0),
      processedAt: null,
    });
  return { db, commit, cursors, processed };
}

function consumer(
  db: ReturnType<typeof fakeDatabase>['db'],
  clock: { now: number },
  overrides: Partial<OutboxConsumerOptions> = {},
) {
  return new OutboxConsumer(db as unknown as PrismaService, new OutboxService(), {
    name: 'test',
    enabled: false,
    pollIntervalMs: 1000,
    batchSize: 2,
    policy: POLICY,
    now: () => clock.now,
    ...overrides,
  });
}

describe('OutboxConsumer', () => {
  it('dispatches by pattern, in sequence order, inside a request context with the correlation id', async () => {
    const { db, commit } = fakeDatabase();
    const clock = { now: 0 };
    const runner = consumer(db, clock);
    const seen: string[] = [];
    runner.registerHandler(
      'task.',
      (event) => {
        seen.push(`${event.sequence}:${RequestContext.correlationId()}`);
        return Promise.resolve();
      },
      'tasks',
    );
    runner.registerHandler('work_log.created', () => Promise.reject(new Error('never called')));
    commit(1n);
    commit(2n, 'task.archived');
    commit(3n);
    const result = await runner.processPending();
    expect(seen).toEqual(['1:corr-1', '2:corr-2', '3:corr-3']);
    expect(result).toMatchObject({ read: 3, handled: 3, retrying: 0, gaveUp: 0, cursor: '0' });
  });

  it('handles each event once, catches a late commit, and stores the cursor after it settles', async () => {
    const { db, commit, cursors, processed } = fakeDatabase();
    const clock = { now: 0 };
    const runner = consumer(db, clock);
    const handled: bigint[] = [];
    runner.registerHandler('*', (event) => {
      handled.push(event.sequence);
      return Promise.resolve();
    });
    commit(1n);
    commit(3n); // 2 is in a transaction that has not committed yet
    await runner.processPending();
    clock.now = 500;
    commit(2n);
    await runner.processPending();
    expect(handled).toEqual([1n, 3n, 2n]);
    expect(cursors.get('test')).toBe(0n);
    clock.now = 1500;
    const result = await runner.processPending();
    expect(result.cursor).toBe('3');
    expect(cursors.get('test')).toBe(3n);
    expect(handled).toEqual([1n, 3n, 2n]);
    expect([...processed].sort()).toEqual([1n, 2n, 3n]);
  });

  it('retries a failing handler without re-running the ones that succeeded, then gives up', async () => {
    const { db, commit, cursors } = fakeDatabase();
    const clock = { now: 0 };
    const runner = consumer(db, clock);
    const ok = jest.fn(() => Promise.resolve());
    const failing = jest.fn(() => Promise.reject(new Error('boom')));
    runner.registerHandler('task.created', ok, 'ok');
    runner.registerHandler('task.created', failing, 'failing');
    commit(1n);

    expect(await runner.processPending()).toMatchObject({ retrying: 1, gaveUp: 0 });
    clock.now = 50; // before the retry is due
    expect(await runner.processPending()).toMatchObject({ retrying: 0, handled: 0 });
    clock.now = 100;
    expect(await runner.processPending()).toMatchObject({ retrying: 1 });
    clock.now = 300;
    expect(await runner.processPending()).toMatchObject({ gaveUp: 1 });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(3);
    clock.now = 2000;
    await runner.processPending();
    expect(cursors.get('test')).toBe(1n);
  });

  it('starts at the newest event when it starts for the first time, and resumes from the stored cursor', async () => {
    const { db, commit, cursors } = fakeDatabase();
    const clock = { now: 0 };
    commit(1n);
    commit(2n);
    const runner = consumer(db, clock, { pollIntervalMs: 60_000 });
    const handled: bigint[] = [];
    runner.registerHandler('*', (event) => {
      handled.push(event.sequence);
      return Promise.resolve();
    });
    await runner.start();
    await runner.stop();
    expect(cursors.get('test')).toBe(2n);
    commit(3n);
    await runner.processPending();
    expect(handled).toEqual([3n]);

    // A second process with the same name resumes after the stored cursor.
    cursors.set('test', 3n);
    const again = consumer(db, clock);
    const later: bigint[] = [];
    again.registerHandler('*', (event) => {
      later.push(event.sequence);
      return Promise.resolve();
    });
    commit(4n);
    await again.processPending();
    expect(later).toEqual([4n]);
  });

  it('reports a backlog when a pass reaches its limit', async () => {
    const { db, commit } = fakeDatabase();
    const runner = consumer(db, { now: 0 }, { batchSize: 2, maxEventsPerPass: 2 });
    runner.registerHandler('*', () => Promise.resolve());
    [1n, 2n, 3n].forEach((sequence) => commit(sequence));
    expect(await runner.processPending()).toMatchObject({ read: 2, backlog: true });
  });

  it('works through a window larger than one pass instead of re-reading the same events (no hot loop)', async () => {
    const { db, commit, cursors } = fakeDatabase();
    const clock = { now: 0 };
    const runner = consumer(db, clock, { batchSize: 2, maxEventsPerPass: 2 });
    const handled: bigint[] = [];
    runner.registerHandler('*', (event) => {
      handled.push(event.sequence);
      return Promise.resolve();
    });
    [1n, 2n, 3n, 4n, 5n].forEach((sequence) => commit(sequence));

    expect(await runner.processPending()).toMatchObject({ read: 2, handled: 2, backlog: true });
    expect(await runner.processPending()).toMatchObject({ read: 2, handled: 2, backlog: true });
    expect(await runner.processPending()).toMatchObject({ read: 1, handled: 1, backlog: false });
    expect(handled).toEqual([1n, 2n, 3n, 4n, 5n]);
    // Back at the cursor: the window is re-scanned; nothing new is handled.
    expect(await runner.processPending()).toMatchObject({ handled: 0, backlog: true });
    // Once settled, the cursor moves, only over what a read from the cursor covered.
    clock.now = 5000;
    await runner.processPending(); // continues after the high water mark: no new events
    const fromCursor = await runner.processPending();
    expect(fromCursor.cursor).toBe('2');
    expect(cursors.get('test')).toBe(2n);
  });

  it('does not overlap passes: a second call joins the running one', async () => {
    const { db, commit } = fakeDatabase();
    const runner = consumer(db, { now: 0 });
    let calls = 0;
    runner.registerHandler('*', async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    commit(1n);
    const [first, second] = await Promise.all([runner.processPending(), runner.processPending()]);
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it('after a restart (resetState) handles the unsettled window again: handlers must be idempotent', async () => {
    const { db, commit, cursors } = fakeDatabase();
    const clock = { now: 0 };
    const runner = consumer(db, clock);
    const handled: bigint[] = [];
    runner.registerHandler('*', (event) => {
      handled.push(event.sequence);
      return Promise.resolve();
    });
    commit(1n);
    commit(2n);
    await runner.processPending();
    clock.now = 1000;
    await runner.processPending(); // settles and stores cursor 2
    commit(3n);
    clock.now = 1100;
    await runner.processPending(); // 3 handled, not settled yet
    runner.resetState();
    await runner.processPending();
    expect(cursors.get('test')).toBe(2n);
    expect(handled).toEqual([1n, 2n, 3n, 3n]);
  });

  it('marks a given-up event as processed and moves on to the next one', async () => {
    const { db, commit, processed, cursors } = fakeDatabase();
    const clock = { now: 0 };
    const runner = consumer(db, clock, { policy: { ...POLICY, maxAttempts: 1 } });
    const seen: bigint[] = [];
    runner.registerHandler('*', (event) => {
      seen.push(event.sequence);
      return event.sequence === 1n ? Promise.reject(new Error('poison')) : Promise.resolve();
    });
    commit(1n);
    commit(2n);
    expect(await runner.processPending()).toMatchObject({ handled: 1, gaveUp: 1, retrying: 0 });
    expect([...processed].sort()).toEqual([1n, 2n]);
    clock.now = 1000;
    await runner.processPending();
    expect(cursors.get('test')).toBe(2n);
    expect(seen).toEqual([1n, 2n]);
  });

  it('removes a handler with the function registerHandler returns', async () => {
    const { db, commit } = fakeDatabase();
    const runner = consumer(db, { now: 0 });
    const handler = jest.fn(() => Promise.resolve());
    const remove = runner.registerHandler('*', handler);
    remove();
    commit(1n);
    await runner.processPending();
    expect(handler).not.toHaveBeenCalled();
  });
});
