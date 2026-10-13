/**
 * Event outbox (reusable platform component).
 *
 * Host requirements: a database client (or transaction) with an `outboxEvent` table shaped like
 * the `OutboxWriter` / `OutboxReader` / `OutboxMarker` slices below (`sequence` is a 64-bit
 * autoincrement), and `RequestContext` for the actor and the correlation id. Nothing else: the
 * service has no injected dependencies and can be constructed with `new OutboxService()`.
 */
import { Injectable } from '@nestjs/common';
import { DEFAULT_REDACTED_KEY_PATTERN, redactSnapshot } from '../audit/audit-snapshot';
import { RequestContext } from '../request-context/request-context';

export interface OutboxPublishInput {
  organizationId: string | null;
  /** Dotted event name: `<aggregate>.<past-tense verb>`, for example `work_log.created`. */
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  /** Self-contained description of what happened; consumers should not need to re-read the row. */
  payload: unknown;
}

/** The slice of a database client (or transaction) the outbox writes through. */
export interface OutboxWriter {
  outboxEvent: {
    create(args: {
      data: {
        organizationId: string | null;
        eventType: string;
        aggregateType: string;
        aggregateId: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON column
        payload: any;
        actorId: string | null;
        correlationId: string | null;
      };
    }): PromiseLike<unknown>;
  };
}

/** An outbox row as the database client returns it. */
export interface OutboxEventRow {
  id: string;
  sequence: bigint;
  organizationId: string | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  actorId: string | null;
  correlationId: string | null;
  occurredAt: Date;
  processedAt: Date | null;
}

/** The slice of a database client a consumer reads the outbox through. */
export interface OutboxReader {
  outboxEvent: {
    findMany(args: {
      where: {
        sequence: { gt: bigint };
        organizationId?: string;
        eventType?: { in: string[] };
      };
      orderBy: { sequence: 'asc' };
      take: number;
    }): PromiseLike<OutboxEventRow[]>;
  };
}

/** The slice of a database client a consumer marks events through. */
export interface OutboxMarker {
  outboxEvent: {
    updateMany(args: {
      where: { sequence: { in: bigint[] }; processedAt: null };
      data: { processedAt: Date };
    }): PromiseLike<{ count: number }>;
  };
}

export interface OutboxReadOptions {
  /** Cursor: the sequence of the last event already handled. Omit to start from the beginning. */
  afterSequence?: bigint;
  /** Batch size, 1 to `MAX_OUTBOX_BATCH_SIZE`. Defaults to `DEFAULT_OUTBOX_BATCH_SIZE`. */
  limit?: number;
  /** Only events of this organization. */
  organizationId?: string;
  /** Only these event types. */
  eventTypes?: readonly string[];
}

export const DEFAULT_OUTBOX_BATCH_SIZE = 100;
export const MAX_OUTBOX_BATCH_SIZE = 500;

/** A batch size inside the allowed range, whatever the caller asked for. */
export function clampBatchSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_OUTBOX_BATCH_SIZE;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_OUTBOX_BATCH_SIZE);
}

/**
 * Plain JSON copy of a payload (dates become ISO strings, BigInt becomes a decimal string), with
 * the values of sensitive keys replaced exactly as the audit log does: events are read by
 * consumers and through the API, so a secret must not travel in them either.
 */
function toJsonPayload(payload: unknown): unknown {
  const text = JSON.stringify(payload ?? {}, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
  const json = text === undefined ? {} : (JSON.parse(text) as unknown);
  return redactSnapshot(json, { pattern: DEFAULT_REDACTED_KEY_PATTERN, keys: [] });
}

/**
 * Writes domain events to the outbox, and gives a future consumer the two operations it needs:
 * read the next batch after a cursor, and mark events as handled. There is no consumer yet.
 */
@Injectable()
export class OutboxService {
  /**
   * Pass the transaction client of the change the event describes, so an event exists if and
   * only if the change committed.
   */
  async publish(tx: OutboxWriter, input: OutboxPublishInput): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        organizationId: input.organizationId,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: toJsonPayload(input.payload),
        actorId: RequestContext.actor()?.userId ?? null,
        correlationId: RequestContext.correlationId(),
      },
    });
  }

  /**
   * The next events after the cursor, in `sequence` order, at most one batch. A consumer keeps
   * the `sequence` of the last row it handled and passes it as `afterSequence` next time.
   *
   * Sequence numbers are assigned at insert, not at commit, so a transaction that is still open
   * can later reveal a lower sequence than one already read. A consumer that must not miss
   * events should re-read a short window or rely on `processedAt` rather than the cursor alone.
   */
  async readAfter(db: OutboxReader, options: OutboxReadOptions = {}): Promise<OutboxEventRow[]> {
    return db.outboxEvent.findMany({
      where: {
        sequence: { gt: options.afterSequence ?? 0n },
        ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
        ...(options.eventTypes === undefined ? {} : { eventType: { in: [...options.eventTypes] } }),
      },
      orderBy: { sequence: 'asc' },
      take: clampBatchSize(options.limit),
    });
  }

  /**
   * Marks events as handled and returns how many were newly marked. Events already marked keep
   * their original time, so calling it twice is harmless. Nothing calls this yet.
   */
  async markProcessed(
    db: OutboxMarker,
    sequences: readonly bigint[],
    processedAt: Date = new Date(),
  ): Promise<number> {
    if (sequences.length === 0) {
      return 0;
    }
    const result = await db.outboxEvent.updateMany({
      where: { sequence: { in: [...sequences] }, processedAt: null },
      data: { processedAt },
    });
    return result.count;
  }
}
