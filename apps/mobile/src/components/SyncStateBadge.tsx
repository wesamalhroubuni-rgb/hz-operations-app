import { t } from '../i18n';
import type { LogSyncState } from '../logic/sync';
import { Badge, type Tone } from './Badge';

const TONES: Record<LogSyncState, Tone> = {
  pending: 'warning',
  failed: 'danger',
  synced: 'success',
};

/**
 * A log's sync state as a badge. Lists show only what needs attention (`hideSynced`); the
 * log's detail shows "Sent" too.
 */
export function SyncStateBadge({
  state,
  hideSynced = false,
}: Readonly<{ state: LogSyncState; hideSynced?: boolean }>) {
  if (hideSynced && state === 'synced') return null;
  return <Badge label={t(`sync.logState.${state}`)} tone={TONES[state]} />;
}
