/**
 * Small in-process concurrency tools (reusable platform component). They hold state in process
 * memory: with several API instances each instance has its own limit, which is what they are
 * for (they protect the memory and CPU of one process). Imports nothing from the Operations
 * domain.
 */

/** A caller waited longer than allowed for a free slot. Hosts map it to 503. */
export class ConcurrencyLimitTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`No free slot after waiting ${waitedMs} ms`);
    this.name = 'ConcurrencyLimitTimeoutError';
  }
}

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

/**
 * At most `max` pieces of work run at once; the others wait in arrival order. A caller that
 * waits longer than `waitTimeoutMs` gives up with {@link ConcurrencyLimitTimeoutError} (the work
 * it would have run is never started).
 */
export class ConcurrencyLimit {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly max: number,
    readonly waitTimeoutMs: number,
  ) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('ConcurrencyLimit needs max >= 1');
    }
  }

  /** Work running now (tests and diagnostics). */
  get running(): number {
    return this.active;
  }

  /** Callers waiting for a slot (tests and diagnostics). */
  get waiting(): number {
    return this.waiters.length;
  }

  async run<Result>(work: () => Promise<Result>): Promise<Result> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new ConcurrencyLimitTimeoutError(this.waitTimeoutMs));
        }, this.waitTimeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // The slot passes straight to the next caller: `active` does not change.
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}

/**
 * Runs work for the same key one after the other (work for different keys runs in parallel).
 * The second caller for a key starts only once the first has finished, whether it succeeded or
 * failed, so it can re-read the state the first one left behind. Keys are forgotten when idle.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  /** Keys with work running or queued (tests). */
  get size(): number {
    return this.tails.size;
  }

  run<Result>(key: string, work: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }
}
