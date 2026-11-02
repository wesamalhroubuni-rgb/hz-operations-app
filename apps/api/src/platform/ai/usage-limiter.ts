import { effectiveAiLimit } from '@ops/shared';
import type { AiOrganizationLimitsResolver, AiUsageReader } from './ai-types';

export interface AiLimitsInForce {
  dailyRequestLimit: number;
  dailyCostLimitUsd: number;
  envDailyRequestLimit: number;
  envDailyCostLimitUsd: number;
  rateLimitPerUserPerMinute: number;
}

export type AiLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      failure: 'rate_limited' | 'limit_reached';
      /** `rate_limited`, `daily_request_limit`, `daily_cost_limit`. */
      errorCode: string;
      retryAfterSeconds?: number;
    };

const MINUTE_MS = 60_000;

/**
 * The AI usage limits (ADR-0010 section 7), checked before every provider call:
 * 1. per key (normally the user) and minute, in memory per process (sliding window);
 * 2. the organization's requests and estimated cost of the current UTC day, read from the
 *    trace table (`limited` rows do not count) against min(environment, organization).
 */
export class AiUsageLimiter {
  /** Start times (ms) of the calls of the last minute, per rate-limit key. */
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly env: {
      dailyRequestLimit: number;
      dailyCostLimitUsd: number;
      rateLimitPerUserPerMinute: number;
    },
    private readonly organizations: AiOrganizationLimitsResolver,
    private readonly usage: AiUsageReader,
  ) {}

  async limitsFor(organizationId: string): Promise<AiLimitsInForce> {
    const own = await this.organizations.limitsFor(organizationId);
    return {
      dailyRequestLimit: effectiveAiLimit(this.env.dailyRequestLimit, own.dailyRequestLimit),
      dailyCostLimitUsd: effectiveAiLimit(this.env.dailyCostLimitUsd, own.dailyCostLimitUsd),
      envDailyRequestLimit: this.env.dailyRequestLimit,
      envDailyCostLimitUsd: this.env.dailyCostLimitUsd,
      rateLimitPerUserPerMinute: this.env.rateLimitPerUserPerMinute,
    };
  }

  /**
   * Decides whether one more call may start now, and if so counts it against the per-minute
   * window of `rateLimitKey` (null: not rate limited).
   */
  async check(
    organizationId: string,
    rateLimitKey: string | null,
    now: Date,
  ): Promise<AiLimitDecision> {
    if (rateLimitKey !== null) {
      const since = now.getTime() - MINUTE_MS;
      const recent = (this.windows.get(rateLimitKey) ?? []).filter((at) => at > since);
      if (recent.length >= this.env.rateLimitPerUserPerMinute) {
        this.windows.set(rateLimitKey, recent);
        const retryAfterMs = recent[0]! + MINUTE_MS - now.getTime();
        return {
          allowed: false,
          failure: 'rate_limited',
          errorCode: 'rate_limited',
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
      }
      // Reserved before the database reads, so concurrent calls cannot all pass.
      recent.push(now.getTime());
      this.windows.set(rateLimitKey, recent);
    }
    const release = () => {
      const times = rateLimitKey === null ? undefined : this.windows.get(rateLimitKey);
      const index = times?.lastIndexOf(now.getTime()) ?? -1;
      if (index >= 0) {
        times!.splice(index, 1);
      }
    };

    try {
      const limits = await this.limitsFor(organizationId);
      const today = await this.usage.today(organizationId, now);
      if (today.requests >= limits.dailyRequestLimit) {
        release();
        return { allowed: false, failure: 'limit_reached', errorCode: 'daily_request_limit' };
      }
      if (today.costUsd >= limits.dailyCostLimitUsd) {
        release();
        return { allowed: false, failure: 'limit_reached', errorCode: 'daily_cost_limit' };
      }
    } catch (error) {
      release();
      throw error;
    }
    this.prune(now);
    return { allowed: true };
  }

  /** Drops keys without a call in the last minute, so the map does not grow without end. */
  private prune(now: Date): void {
    if (this.windows.size < 1000) {
      return;
    }
    const since = now.getTime() - MINUTE_MS;
    for (const [key, times] of this.windows) {
      if (!times.some((at) => at > since)) {
        this.windows.delete(key);
      }
    }
  }

  /** Forgets every per-minute window (tests). */
  reset(): void {
    this.windows.clear();
  }
}
