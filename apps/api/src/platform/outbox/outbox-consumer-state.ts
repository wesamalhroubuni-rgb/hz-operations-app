/**
 * The bookkeeping of an outbox consumer, as pure logic with no I/O, so its ordering, lag and
 * retry rules can be unit-tested without a database or timers (reusable platform component).
 *
 * THE PROBLEM. Outbox sequence numbers are assigned when a row is inserted, not when its
 * transaction commits. Transaction A can take sequence 10, transaction B sequence 11, B commits,
 * and only later A commits. A consumer that read 11 and moved its cursor to 11 would never see 10.
 *
 * THE RULE (`advance`). Every event above the cursor is handled as soon as it is seen, so a late
 * commit costs no latency. The CURSOR, however, only moves past an event once that event was
 * first seen at least `settleMs` ago. Why that is enough: if B's event (11) was first seen at
 * time F, it was inserted before F; A took 10 before that, so A started before F and, as no
 * transaction lives longer than `settleMs`, A has committed or rolled back by F + `settleMs`. So
 * once 11 has been known for `settleMs`, every lower sequence is either visible (and was read by
 * the re-scan of the window above the cursor) or will never exist (a rolled-back gap). Only the
 * application's own clock is compared with itself: no clock skew with the database matters.
 *
 * The cost: the window between the cursor and the newest event (about `settleMs` worth of
 * events) is re-read on every poll; events in it that were already handled are not handled
 * again (`isDue`). After a restart the window is handled again: handlers must be idempotent.
 *
 * LARGE WINDOWS. A pass reads at most a fixed number of events. When more than that arrive
 * within `settleMs`, re-reading from the cursor would return the same, already handled events
 * again and again (the cursor cannot move yet). So after a pass that stopped at its limit, the
 * next read continues after the HIGH WATER mark (the highest sequence seen), until a read
 * reaches the end; then reading starts at the cursor again (`readAfter`, `windowRead`).
 * Continuation reads skip the lower part of the window, where a late commit may land, so the
 * cursor only moves after a read that started at the cursor, and only over what that read
 * covered (`advance(now, upTo)`): the late-commit rule above still holds.
 *
 * FAILURES. A handler that throws is retried with exponential backoff (`retryBaseMs` doubling up
 * to `retryMaxMs`). Handlers of the same event that succeeded are not run again. After
 * `maxAttempts` failed attempts the event is given up on (logged by the runner as an error) and
 * counts as handled, so one poisonous event cannot stall the consumer forever. A failing event
 * holds the cursor while it is being retried; later events are still handled meanwhile.
 */

export interface ConsumerPolicy {
  /** How long an event must have been known before the cursor may pass it. */
  settleMs: number;
  /** Failed attempts after which an event is given up on. */
  maxAttempts: number;
  /** Delay before the first retry; doubled on each further failure. */
  retryBaseMs: number;
  /** Upper bound of the retry delay. */
  retryMaxMs: number;
}

/**
 * Defaults. `settleMs` is 60 s: interactive transactions in this API time out after 5 s (the
 * Prisma default), so 60 s leaves a wide margin for a slow commit. Five attempts with a 2 s base
 * span about 30 s of retries.
 */
export const DEFAULT_CONSUMER_POLICY: ConsumerPolicy = {
  settleMs: 60_000,
  maxAttempts: 5,
  retryBaseMs: 2_000,
  retryMaxMs: 60_000,
};

interface PendingEvent {
  firstSeenAt: number;
  /** All handlers succeeded, or the event was given up on. */
  done: boolean;
  attempts: number;
  nextAttemptAt: number;
  /** Handlers that already succeeded for this event (not run again on a retry). */
  succeeded: Set<string>;
}

export type FailureOutcome =
  { kind: 'retry'; attempts: number; retryAt: number } | { kind: 'give_up'; attempts: number };

export class ConsumerState {
  private cursorValue: bigint;
  private highWaterValue: bigint;
  /** Set after a read that stopped at its limit: the next read continues after this. */
  private continueAfter: bigint | null = null;
  private readonly pending = new Map<bigint, PendingEvent>();

  constructor(
    cursor: bigint,
    private readonly policy: ConsumerPolicy = DEFAULT_CONSUMER_POLICY,
  ) {
    this.cursorValue = cursor;
    this.highWaterValue = cursor;
  }

  /** The highest sequence ever observed (or the cursor). */
  get highWater(): bigint {
    return this.highWaterValue;
  }

  /** Where the next read starts: after the cursor, or after the high water mark (see header). */
  get readAfter(): bigint {
    return this.continueAfter ?? this.cursorValue;
  }

  /** True when the next read starts at the cursor (and may therefore advance it). */
  get readingFromCursor(): boolean {
    return this.continueAfter === null;
  }

  /**
   * Records how the last read ended (call it after `observe`). A read that stopped at its limit
   * makes the next one continue after the high water mark; a read that reached the end makes
   * the next one start at the cursor again.
   */
  windowRead(reachedEnd: boolean): void {
    this.continueAfter = reachedEnd ? null : this.highWaterValue;
  }

  /** The sequence of the last event below which everything is settled. */
  get cursor(): bigint {
    return this.cursorValue;
  }

  /** Events above the cursor that are being tracked (for tests and diagnostics). */
  get trackedCount(): number {
    return this.pending.size;
  }

  /** Records that these events were read at `now`. Events at or below the cursor are ignored. */
  observe(sequences: readonly bigint[], now: number): void {
    for (const sequence of sequences) {
      if (sequence > this.highWaterValue) {
        this.highWaterValue = sequence;
      }
      if (sequence > this.cursorValue && !this.pending.has(sequence)) {
        this.pending.set(sequence, {
          firstSeenAt: now,
          done: false,
          attempts: 0,
          nextAttemptAt: now,
          succeeded: new Set(),
        });
      }
    }
  }

  /** True when the event should be handled now: not done, and not waiting for a retry. */
  isDue(sequence: bigint, now: number): boolean {
    const entry = this.pending.get(sequence);
    return entry !== undefined && !entry.done && entry.nextAttemptAt <= now;
  }

  /** True when this handler already succeeded for the event. */
  hasSucceeded(sequence: bigint, handlerKey: string): boolean {
    return this.pending.get(sequence)?.succeeded.has(handlerKey) ?? false;
  }

  handlerSucceeded(sequence: bigint, handlerKey: string): void {
    this.pending.get(sequence)?.succeeded.add(handlerKey);
  }

  /** Every handler of the event succeeded (or it had none). */
  markDone(sequence: bigint): void {
    const entry = this.pending.get(sequence);
    if (entry) {
      entry.done = true;
    }
  }

  /**
   * One attempt at the event failed (any of its handlers threw). Either schedules a retry or,
   * after `maxAttempts`, gives up and marks the event done.
   */
  attemptFailed(sequence: bigint, now: number): FailureOutcome {
    const entry = this.pending.get(sequence);
    if (!entry) {
      return { kind: 'give_up', attempts: 0 };
    }
    entry.attempts += 1;
    if (entry.attempts >= this.policy.maxAttempts) {
      entry.done = true;
      return { kind: 'give_up', attempts: entry.attempts };
    }
    const delay = Math.min(
      this.policy.retryBaseMs * 2 ** (entry.attempts - 1),
      this.policy.retryMaxMs,
    );
    entry.nextAttemptAt = now + delay;
    return { kind: 'retry', attempts: entry.attempts, retryAt: entry.nextAttemptAt };
  }

  /**
   * Moves the cursor over the leading run of events that are done and settled (see the rule in
   * the header), never past `upTo` when given (the last sequence a read from the cursor
   * covered). Returns the new cursor when it moved, otherwise null.
   */
  advance(now: number, upTo: bigint | null = null): bigint | null {
    const ordered = [...this.pending.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const before = this.cursorValue;
    for (const sequence of ordered) {
      const entry = this.pending.get(sequence)!;
      if (upTo !== null && sequence > upTo) {
        break;
      }
      if (!entry.done || now - entry.firstSeenAt < this.policy.settleMs) {
        break;
      }
      this.cursorValue = sequence;
      this.pending.delete(sequence);
    }
    return this.cursorValue === before ? null : this.cursorValue;
  }
}

/**
 * Whether a handler registered for `pattern` receives events of `eventType`: an exact name
 * (`task.created`), a prefix ending with a dot (`task.`), a prefix ending with `*` (`task.*`,
 * `work_log*`), or `*` for every event.
 */
export function matchesEventPattern(pattern: string, eventType: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('*')) {
    return eventType.startsWith(pattern.slice(0, -1));
  }
  if (pattern.endsWith('.')) {
    return eventType.startsWith(pattern);
  }
  return pattern === eventType;
}
