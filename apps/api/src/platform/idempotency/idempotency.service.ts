/**
 * `Idempotency-Key` storage (reusable platform component, ADR-0008 section 4).
 *
 * Host requirements: a global `PrismaService` whose client has the `idempotencyRecord` table
 * (organizationId, userId, key unique; method, path, requestHash, statusCode, responseBody,
 * lockedUntil, createdAt, completedAt, expiresAt) and the platform clock (`AUTH_CLOCK`).
 *
 * ## Why this is safe without sharing the business transaction
 *
 * The claim, the business write and the stored answer are three steps, in this order:
 *
 * 1. `begin` claims the key in its own committed statement (insert, or a conditional take-over).
 *    A second request with the key now sees it and answers 409 `request_in_progress` (or replays).
 * 2. The route runs. Its write commits (or not) in the route's own transaction.
 * 3. `complete` stores the final answer, or `release` deletes the claim for a non-final one.
 *
 * A crash can only stop the sequence between two steps:
 * - after 1, before the write commits: nothing was written; the claim's lock runs out
 *   (`IDEMPOTENCY_LOCK_SECONDS`) and the retry takes the claim over and runs the write once;
 * - after the write commits, before 3: the retry takes over and runs the route again. That is
 *   harmless by construction of the routes marked idempotent: a create is deduplicated by its
 *   `clientId` (200 with the stored record) and an edit or status change that is already in
 *   place is a no-op that answers 200 with the current record, even with a stale
 *   `expectedVersion` (ADR-0008 section 1). So a crash never produces a duplicate, and never a
 *   stored success without the write (the answer is stored only after the write returned).
 *
 * Storing the answer inside the business transaction would close the second gap entirely, but
 * would couple every domain service to this module; the no-op rule makes it unnecessary.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { IDEMPOTENCY_LOCK_SECONDS, IDEMPOTENCY_RETENTION_DAYS } from '@ops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AUTH_CLOCK, type Clock } from '../auth/clock';
import { classifyRepeat } from './idempotency';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;

export interface IdempotencyRequest {
  organizationId: string;
  userId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
}

/** A claim held by the current request: complete or release it. */
export interface IdempotencyClaim {
  id: string;
}

export interface StoredAnswer {
  statusCode: number;
  body: unknown;
}

export type IdempotencyBegin =
  | { kind: 'claimed'; claim: IdempotencyClaim }
  | { kind: 'replay'; answer: StoredAnswer }
  | { kind: 'in_progress' }
  | { kind: 'reused' };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

@Injectable()
export class IdempotencyService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Idempotency');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_CLOCK) private readonly clock: Clock,
  ) {}

  /** Claims the key, or says what an earlier request with it left behind. */
  async begin(request: IdempotencyRequest): Promise<IdempotencyBegin> {
    // Two rounds at most: an expired row found in the first is deleted, then the key is new.
    for (let round = 0; round < 2; round += 1) {
      const now = this.clock.now();
      const lockedUntil = new Date(now.getTime() + IDEMPOTENCY_LOCK_SECONDS * 1000);
      try {
        const created = await this.prisma.idempotencyRecord.create({
          data: {
            organizationId: request.organizationId,
            userId: request.userId,
            key: request.key,
            method: request.method,
            path: request.path,
            requestHash: request.requestHash,
            lockedUntil,
            createdAt: now,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_DAYS * DAY_MS),
          },
          select: { id: true },
        });
        return { kind: 'claimed', claim: { id: created.id } };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }

      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: {
          organizationId_userId_key: {
            organizationId: request.organizationId,
            userId: request.userId,
            key: request.key,
          },
        },
      });
      if (!existing) {
        continue; // deleted in between (expired and cleaned up): claim again
      }
      switch (classifyRepeat(existing, request.requestHash, now)) {
        case 'expired':
          await this.prisma.idempotencyRecord.deleteMany({
            where: { id: existing.id, expiresAt: existing.expiresAt },
          });
          continue;
        case 'reused':
          return { kind: 'reused' };
        case 'replay':
          return {
            kind: 'replay',
            answer: { statusCode: existing.statusCode ?? 200, body: existing.responseBody },
          };
        case 'in_progress':
          return { kind: 'in_progress' };
        case 'take_over': {
          // Conditional on the lock we saw: of two simultaneous retries, one takes over.
          const { count } = await this.prisma.idempotencyRecord.updateMany({
            where: { id: existing.id, statusCode: null, lockedUntil: existing.lockedUntil },
            data: { lockedUntil },
          });
          return count === 1
            ? { kind: 'claimed', claim: { id: existing.id } }
            : { kind: 'in_progress' };
        }
      }
    }
    return { kind: 'in_progress' };
  }

  /** Stores the final answer of a claim. Only an unanswered claim is updated. */
  async complete(claim: IdempotencyClaim, answer: StoredAnswer): Promise<void> {
    const now = this.clock.now();
    await this.prisma.idempotencyRecord.updateMany({
      where: { id: claim.id, statusCode: null },
      data: {
        statusCode: answer.statusCode,
        // A JSON copy: what the client received, without class instances or undefined members.
        responseBody: JSON.parse(JSON.stringify(answer.body ?? null)) as never,
        completedAt: now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_DAYS * DAY_MS),
      },
    });
  }

  /** Deletes an unanswered claim, so a retry of a non-final answer runs again. */
  async release(claim: IdempotencyClaim): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({ where: { id: claim.id, statusCode: null } });
  }

  /** Deletes the keys past their retention. Returns how many. */
  async deleteExpired(): Promise<number> {
    const { count } = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lte: this.clock.now() } },
    });
    return count;
  }

  /** Hourly, the first run one hour after start-up (tests never live that long). */
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.deleteExpired().then(
        (count) => {
          if (count > 0) {
            this.logger.log(`Deleted ${count} expired idempotency key(s)`);
          }
        },
        (error: unknown) =>
          this.logger.warn(
            `Idempotency cleanup failed: ${error instanceof Error ? error.name : 'error'}`,
          ),
      );
    }, CLEANUP_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
