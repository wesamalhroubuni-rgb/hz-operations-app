import type { ApiFailure } from './client.js';

import type { HealthMonitorState } from './health-monitor.js';

export type StatusTone = 'pending' | 'good' | 'warning' | 'bad';

/** What the API status card shows. The web and mobile apps use the same states and wording. */
export interface HealthStatusView {
  tone: StatusTone;
  title: string;
  detail: string;
  /** A request is in flight or an automatic retry is scheduled. */
  busy: boolean;
}

/** Label of the button that starts a manual check. */
export const CHECK_AGAIN_LABEL = 'Check again';

function describeFailure(failure: ApiFailure): { title: string; detail: string } {
  switch (failure.kind) {
    case 'network':
      return { title: 'API unreachable', detail: 'No response from the API. Is it running?' };
    case 'timeout':
      return { title: 'API unreachable', detail: 'The API did not answer in time.' };
    case 'invalid-response':
    case 'http':
      return {
        title: 'Unexpected API response',
        detail: `Something answered, but not with a valid health response (HTTP ${failure.status}).`,
      };
  }
}

/**
 * Maps the health monitor's state to the card's text. `state` is null when the API URL is not
 * configured; `notConfiguredDetail` then explains which variable to set.
 */
export function describeHealth(
  state: HealthMonitorState | null,
  notConfiguredDetail: string,
): HealthStatusView {
  if (state === null) {
    return { tone: 'bad', title: 'API not configured', detail: notConfiguredDetail, busy: false };
  }

  const { result, retry } = state;
  if (result === null) {
    return {
      tone: 'pending',
      title: 'Checking the API…',
      detail: 'Waiting for a response.',
      busy: true,
    };
  }

  if (result.ok) {
    return result.data.database === 'up'
      ? { tone: 'good', title: 'API reachable', detail: 'Database is up.', busy: false }
      : { tone: 'warning', title: 'API reachable', detail: 'Database is down.', busy: false };
  }

  const { title, detail } = describeFailure(result.failure);
  if (retry !== null) {
    return {
      tone: 'bad',
      title,
      detail: `${detail} Retrying automatically (attempt ${retry.attempt} of ${retry.of})…`,
      busy: true,
    };
  }
  if (state.retriesExhausted) {
    return {
      tone: 'bad',
      title,
      detail: `${detail} Automatic retries have stopped. Use "${CHECK_AGAIN_LABEL}" to retry.`,
      busy: false,
    };
  }
  return { tone: 'bad', title, detail, busy: false };
}
