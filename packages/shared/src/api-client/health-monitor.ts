import type { HealthResponse } from '../health.js';
import type { ApiResult } from './client.js';

export type HealthResult = ApiResult<HealthResponse>;

/**
 * Waits before each automatic retry: four attempts spread over 30 seconds. Deliberately slow and
 * finite, because the API logs an error for every /health call while its database is down.
 */
export const HEALTH_RETRY_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 16000];

export interface HealthRetry {
  /** Number of the automatic retry that is waiting or running, starting at 1. */
  attempt: number;
  /** How many automatic retries there are in total. */
  of: number;
}

export interface HealthMonitorState {
  /** A request is in flight. */
  checking: boolean;
  /** The latest answer, or null before the first one (and right after a manual check starts). */
  result: HealthResult | null;
  /** Set while an automatic retry is waiting for its delay or is in flight. */
  retry: HealthRetry | null;
  /** Every automatic retry failed; only a manual check will try again. */
  retriesExhausted: boolean;
}

export interface HealthMonitor {
  getState(): HealthMonitorState;
  /** Calls the listener after every state change. Returns the function that unsubscribes. */
  subscribe(listener: () => void): () => void;
  /** Starts a fresh check now, dropping any pending retry and its attempt count. */
  check(): void;
  /** Cancels the pending retry and ignores any answer still on its way. */
  stop(): void;
}

export interface HealthMonitorOptions {
  /** Performs one health call. Must not throw (the shared API client never does). */
  check: () => Promise<HealthResult>;
  retryDelaysMs?: readonly number[];
}

export const INITIAL_HEALTH_STATE: HealthMonitorState = {
  checking: true,
  result: null,
  retry: null,
  retriesExhausted: false,
};

/**
 * Only "nothing answered" is worth retrying on its own: the API may still be starting. An answer
 * of any kind, including a wrong one, will not change by asking again.
 */
export function isRetryable(result: HealthResult): boolean {
  return !result.ok && (result.failure.kind === 'network' || result.failure.kind === 'timeout');
}

/**
 * Runs the health check and, while the API does not answer, retries it with a growing delay.
 * It stops at the first answer, after the last delay, or when `stop()` is called. Framework-free
 * so it can be unit-tested with fake timers; the React hook only subscribes to it.
 */
export function createHealthMonitor(options: HealthMonitorOptions): HealthMonitor {
  const delays = options.retryDelaysMs ?? HEALTH_RETRY_DELAYS_MS;
  const listeners = new Set<() => void>();
  let state = INITIAL_HEALTH_STATE;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Incremented by check() and stop(), so an answer to an older request can be recognised.
  let generation = 0;

  function setState(next: HealthMonitorState): void {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** `retriesDone` is how many automatic retries have already run in this sequence. */
  async function run(current: number, retriesDone: number): Promise<void> {
    const result = await options.check();
    if (current !== generation) {
      return;
    }

    const delayMs = delays[retriesDone];
    if (!isRetryable(result) || delayMs === undefined) {
      setState({
        checking: false,
        result,
        retry: null,
        retriesExhausted: isRetryable(result) && delays.length > 0,
      });
      return;
    }

    const retry: HealthRetry = { attempt: retriesDone + 1, of: delays.length };
    setState({ checking: false, result, retry, retriesExhausted: false });
    timer = setTimeout(() => {
      timer = null;
      setState({ checking: true, result, retry, retriesExhausted: false });
      void run(current, retriesDone + 1);
    }, delayMs);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check() {
      cancelTimer();
      generation += 1;
      setState(INITIAL_HEALTH_STATE);
      void run(generation, 0);
    },
    stop() {
      cancelTimer();
      generation += 1;
    },
  };
}
