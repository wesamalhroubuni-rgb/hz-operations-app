import { type Clock, systemClock } from './clock';

/**
 * Rate limiting behind an interface. The in-memory implementation below is right for one API
 * process; with several instances, bind `RATE_LIMITER` to an implementation on a shared store
 * (Redis, PostgreSQL) with the same contract.
 */

export interface RateLimitRule {
  /** Attempts allowed per window. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next attempt can succeed; 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one attempt under `key` and says whether it is within the rule. */
  hit(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
  /** Forgets everything (tests). */
  reset(): Promise<void>;
}

export const RATE_LIMITER = Symbol('platform.rateLimiter');

interface Window {
  startedAt: number;
  count: number;
  windowMs: number;
}

/**
 * Fixed window per key, in process memory.
 *
 * Memory is bounded: expired windows are swept when the map grows past `maxKeys`, and if it is
 * still full the oldest windows are dropped. Dropping a window forgives its attempts, so the
 * bound trades a little strictness under a flood of distinct keys for a hard memory limit; the
 * account lockout does not depend on this limiter.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxKeys = 50_000,
  ) {}

  hit(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime();
    const windowMs = rule.windowSeconds * 1000;
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= window.windowMs || now < window.startedAt) {
      if (!window && this.windows.size >= this.maxKeys) {
        this.evict(now);
      }
      window = { startedAt: now, count: 0, windowMs };
      // Re-inserting keeps the map ordered by window start, which `evict` relies on.
      this.windows.delete(key);
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= rule.limit) {
      return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000));
    return Promise.resolve({ allowed: false, retryAfterSeconds });
  }

  reset(): Promise<void> {
    this.windows.clear();
    return Promise.resolve();
  }

  /** Number of keys held (tests). */
  get size(): number {
    return this.windows.size;
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= window.windowMs) {
        this.windows.delete(key);
      }
    }
    // Still full: drop the oldest tenth.
    let excess = this.windows.size - Math.floor(this.maxKeys * 0.9);
    for (const key of this.windows.keys()) {
      if (excess <= 0) {
        break;
      }
      this.windows.delete(key);
      excess -= 1;
    }
  }
}
