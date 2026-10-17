/**
 * Outbox consumer (reusable platform component): a background runner that reads the event
 * outbox in `sequence` order and hands each event to the handlers the host registered for its
 * type. The platform knows no event names: hosts call `registerHandler('task.created', ...)` or
 * `registerHandler('work_log.', ...)` from their own modules.
 *
 * Host requirements: a global `PrismaService` with the `outboxEvent` and `outboxConsumerCursor`
 * tables, and `OUTBOX_CONSUMER_OPTIONS` (provided by the notifications module from
 * configuration: `OUTBOX_CONSUMER_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`).
 *
 * Behaviour:
 * - Started on application bootstrap only when enabled (configuration value exactly `true`;
 *   unit and integration tests leave it off). The first start with no stored cursor begins at the
 *   newest existing event: history is not replayed into notifications.
 * - Polls every `pollIntervalMs` (a `setTimeout` chain, so runs never overlap), and immediately
 *   again while there is a backlog. `processPending()` runs one pass on demand (tests).
 * - Ordering, the late-commit rule, retries and give-up: see ./outbox-consumer-state.ts.
 *   Events are handled in sequence order within a pass; a retried event is handled after later
 *   ones. Handlers must therefore be idempotent and must not rely on strict ordering.
 * - Each handler runs inside a `RequestContext` carrying the event's correlation id (no actor),
 *   so what it logs or writes traces back to the request that caused the event.
 * - Fully handled events get `processedAt` (informational; the cursor is the source of truth).
 * - Several API instances may run it at once: each handles every event, so handlers must be
 *   idempotent (the notification handlers are, through a unique key) and the stored cursor only
 *   ever moves forward.
 * - Graceful shutdown: on module destroy the timer stops and the pass in flight is awaited.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestContext } from '../request-context/request-context';
import {
  ConsumerState,
  DEFAULT_CONSUMER_POLICY,
  matchesEventPattern,
  type ConsumerPolicy,
} from './outbox-consumer-state';
import { OutboxService, type OutboxEventRow } from './outbox.service';

export type OutboxEventHandler = (event: OutboxEventRow) => Promise<void>;

export interface OutboxConsumerOptions {
  /** The consumer's name: its row in `OutboxConsumerCursor`. */
  name: string;
  /** Start the polling loop on application bootstrap. */
  enabled: boolean;
  pollIntervalMs: number;
  /** Events read per query (at most `MAX_OUTBOX_BATCH_SIZE`). */
  batchSize?: number;
  /** Upper bound of events read in one pass; the next pass follows immediately. */
  maxEventsPerPass?: number;
  policy?: Partial<ConsumerPolicy>;
  /** Milliseconds clock (tests). */
  now?: () => number;
}

export const OUTBOX_CONSUMER_OPTIONS = Symbol('platform.outboxConsumerOptions');

export const DEFAULT_OUTBOX_CONSUMER_NAME = 'platform.notifications';

export interface ProcessResult {
  /** Events read in this pass (the re-scanned window included). */
  read: number;
  /** Events whose handlers all succeeded in this pass. */
  handled: number;
  /** Events that failed in this pass and will be retried. */
  retrying: number;
  /** Events given up on in this pass. */
  gaveUp: number;
  /** The stored cursor after the pass, as a decimal string. */
  cursor: string;
  /** True when the pass stopped at `maxEventsPerPass`: more is waiting. */
  backlog: boolean;
}

interface Registration {
  key: string;
  pattern: string;
  handle: OutboxEventHandler;
}

/** The slice of the cursor table the consumer uses. */
interface CursorTable {
  findUnique(args: {
    where: { consumer: string };
  }): PromiseLike<{ consumer: string; lastSequence: bigint } | null>;
  upsert(args: {
    where: { consumer: string };
    create: { consumer: string; lastSequence: bigint };
    update: Record<string, never>;
  }): PromiseLike<{ consumer: string; lastSequence: bigint }>;
  updateMany(args: {
    where: { consumer: string; lastSequence: { lt: bigint } };
    data: { lastSequence: bigint };
  }): PromiseLike<{ count: number }>;
}

const FAILURE_LOG_EVERY = 30;

@Injectable()
export class OutboxConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxConsumer');
  private readonly registrations: Registration[] = [];
  private readonly policy: ConsumerPolicy;
  private readonly batchSize: number;
  private readonly maxEventsPerPass: number;
  private readonly now: () => number;
  private state: ConsumerState | null = null;
  private running: Promise<ProcessResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private handlerCounter = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @Inject(OUTBOX_CONSUMER_OPTIONS) private readonly options: OutboxConsumerOptions,
  ) {
    this.policy = { ...DEFAULT_CONSUMER_POLICY, ...options.policy };
    this.batchSize = options.batchSize ?? 200;
    this.maxEventsPerPass = options.maxEventsPerPass ?? 2000;
    this.now = options.now ?? Date.now;
  }

  get name(): string {
    return this.options.name;
  }

  /**
   * Registers a handler for an event type: an exact name, a prefix ending with `.` or `*`, or
   * `*`. `name` labels it in logs (defaults to the pattern and a number). Returns a function that
   * removes it. Register during module initialisation, before the consumer starts.
   */
  registerHandler(pattern: string, handle: OutboxEventHandler, name?: string): () => void {
    this.handlerCounter += 1;
    const registration: Registration = {
      key: name ?? `${pattern}#${this.handlerCounter}`,
      pattern,
      handle,
    };
    this.registrations.push(registration);
    return () => {
      const index = this.registrations.indexOf(registration);
      if (index !== -1) {
        this.registrations.splice(index, 1);
      }
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.enabled) {
      await this.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Starts the polling loop (idempotent). */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    try {
      await this.initialiseCursorAtLatest();
    } catch (error) {
      // The database may be down at boot; the loop keeps trying and starts from 0 if the row
      // still does not exist when it first reads (see `loadState`).
      this.logger.warn(`Could not initialise the cursor yet: ${describe(error)}`);
    }
    this.logger.log(
      `Outbox consumer "${this.name}" started (every ${this.options.pollIntervalMs} ms, ` +
        `${this.registrations.length} handler(s))`,
    );
    this.schedule(0);
  }

  /** Stops the loop and waits for the pass in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running.catch(() => undefined);
    }
    if (this.started) {
      this.started = false;
      this.logger.log(`Outbox consumer "${this.name}" stopped`);
    }
  }

  /**
   * Forgets the in-memory bookkeeping (as a restart would): the next pass reloads the cursor
   * from the database and handles the window above it again. For tests that empty the database.
   */
  resetState(): void {
    this.state = null;
  }

  /**
   * Runs one pass now: reads the events after the cursor, dispatches them, advances the cursor.
   * A call while a pass is running waits for that pass and returns its result.
   */
  processPending(): Promise<ProcessResult> {
    if (this.running) {
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let backlog = false;
    try {
      const result = await this.processPending();
      // Straight on only while passes make progress: a full window of already handled events
      // waits for the normal poll (no hot loop).
      backlog = result.backlog && result.handled + result.retrying + result.gaveUp > 0;
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % FAILURE_LOG_EVERY === 0) {
        this.logger.warn(
          `Outbox consumer pass failed (${this.consecutiveFailures} in a row): ${describe(error)}`,
        );
      }
    }
    this.schedule(backlog ? 0 : this.options.pollIntervalMs);
  }

  private get cursors(): CursorTable {
    return this.prisma.outboxConsumerCursor as unknown as CursorTable;
  }

  /** On the first start ever, the cursor begins at the newest existing event. */
  private async initialiseCursorAtLatest(): Promise<void> {
    const existing = await this.cursors.findUnique({ where: { consumer: this.name } });
    if (existing) {
      return;
    }
    const latest = await this.prisma.outboxEvent.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const row = await this.ensureCursor(latest?.sequence ?? 0n);
    this.logger.log(
      `Outbox consumer "${this.name}" begins after sequence ${row.lastSequence.toString()}`,
    );
  }

  /**
   * The cursor row of this consumer, created at `initial` when missing. An upsert is not atomic:
   * when another instance creates the row at the same moment, the unique key refuses the second
   * insert, and the row that won is read instead.
   */
  private async ensureCursor(initial: bigint): Promise<{ lastSequence: bigint }> {
    try {
      return await this.cursors.upsert({
        where: { consumer: this.name },
        create: { consumer: this.name, lastSequence: initial },
        update: {},
      });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code !== 'P2002') {
        throw error;
      }
      const row = await this.cursors.findUnique({ where: { consumer: this.name } });
      if (!row) {
        throw error;
      }
      return row;
    }
  }

  private async loadState(): Promise<ConsumerState> {
    if (this.state) {
      return this.state;
    }
    const row = await this.ensureCursor(0n);
    this.state = new ConsumerState(row.lastSequence, this.policy);
    return this.state;
  }

  private async readWindow(after: bigint): Promise<{ rows: OutboxEventRow[]; backlog: boolean }> {
    const rows: OutboxEventRow[] = [];
    let from = after;
    for (;;) {
      const batch = await this.outbox.readAfter(this.prisma, {
        afterSequence: from,
        limit: this.batchSize,
      });
      rows.push(...batch);
      if (batch.length < this.batchSize) {
        return { rows, backlog: false };
      }
      if (rows.length >= this.maxEventsPerPass) {
        return { rows, backlog: true };
      }
      from = batch[batch.length - 1]!.sequence;
    }
  }

  private async pass(): Promise<ProcessResult> {
    const state = await this.loadState();
    const fromCursor = state.readingFromCursor;
    const { rows, backlog } = await this.readWindow(state.readAfter);
    const now = this.now();
    state.observe(
      rows.map((row) => row.sequence),
      now,
    );
    state.windowRead(!backlog);

    const finished: bigint[] = [];
    let handled = 0;
    let retrying = 0;
    let gaveUp = 0;
    for (const event of rows) {
      if (!state.isDue(event.sequence, now)) {
        continue;
      }
      const failed = await this.dispatch(state, event);
      if (!failed) {
        state.markDone(event.sequence);
        finished.push(event.sequence);
        handled += 1;
        continue;
      }
      const outcome = state.attemptFailed(event.sequence, now);
      if (outcome.kind === 'give_up') {
        gaveUp += 1;
        finished.push(event.sequence);
        this.logger.error(
          `Gave up on outbox event ${event.sequence.toString()} (${event.eventType}, ` +
            `${event.id}) after ${outcome.attempts} failed attempt(s); it is skipped`,
        );
      } else {
        retrying += 1;
        this.logger.warn(
          `Outbox event ${event.sequence.toString()} (${event.eventType}) failed ` +
            `(attempt ${outcome.attempts}); retrying in ${outcome.retryAt - now} ms`,
        );
      }
    }

    if (finished.length > 0) {
      await this.outbox.markProcessed(this.prisma, finished, new Date(now));
    }
    // Only a read from the cursor may move it, and only over what it covered (see the state).
    const moved = fromCursor
      ? state.advance(now, backlog ? (rows[rows.length - 1]?.sequence ?? state.cursor) : null)
      : null;
    if (moved !== null) {
      await this.cursors.updateMany({
        where: { consumer: this.name, lastSequence: { lt: moved } },
        data: { lastSequence: moved },
      });
    }
    return {
      read: rows.length,
      handled,
      retrying,
      gaveUp,
      cursor: state.cursor.toString(),
      backlog,
    };
  }

  /** Runs the handlers of one event that have not succeeded yet. True when any of them threw. */
  private async dispatch(state: ConsumerState, event: OutboxEventRow): Promise<boolean> {
    let failed = false;
    const handlers = this.registrations.filter((registration) =>
      matchesEventPattern(registration.pattern, event.eventType),
    );
    for (const registration of handlers) {
      if (state.hasSucceeded(event.sequence, registration.key)) {
        continue;
      }
      try {
        await RequestContext.run(
          { correlationId: event.correlationId ?? `outbox-${event.id}`, actor: null },
          () => registration.handle(event),
        );
        state.handlerSucceeded(event.sequence, registration.key);
      } catch (error) {
        failed = true;
        this.logger.warn(
          `Handler "${registration.key}" failed on outbox event ` +
            `${event.sequence.toString()} (${event.eventType}): ${describe(error)}`,
        );
      }
    }
    return failed;
  }
}

/** An error's class and message only (never a stack with values, never a payload). */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
