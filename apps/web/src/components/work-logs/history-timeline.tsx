'use client';

import type { RecordHistory } from '@ops/shared';

import { ErrorState, LoadingState } from '@/components/ui/states';
import { Badge } from '@/components/ui/status-badge';
import { t } from '@/i18n';
import type { OrgTime } from '@/lib/time';
import { historyLineOf } from '@/lib/work-logs/format';

import styles from './work-logs.module.css';

/**
 * `GET /work-logs/:id/history`, oldest first: what happened, who did it (a name only when the
 * caller may see that user; "Someone" otherwise), when (organization time) and whether it came
 * from the phone's offline queue. The API has already limited the fields and redacted them.
 */
export function HistoryTimeline({
  history,
  loading,
  error,
  onRetry,
  orgTime,
}: Readonly<{
  history: RecordHistory | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  orgTime: OrgTime;
}>) {
  if (loading && history === undefined) {
    return <LoadingState inline />;
  }
  if (error && history === undefined) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }
  const items = history?.items ?? [];
  if (items.length === 0) {
    return <p className={styles.muted}>{t('workLogs.history.empty')}</p>;
  }
  return (
    <>
      <ol className={styles.timeline}>
        {items.map((entry) => {
          const line = historyLineOf(entry);
          return (
            <li key={line.id} className={styles.timelineItem}>
              <p className={styles.timelineTitle}>{line.title}</p>
              {line.statusChange ? <p className={styles.hint}>{line.statusChange}</p> : null}
              {line.changed ? <p className={styles.hint}>{line.changed}</p> : null}
              <p className={styles.timelineMeta}>
                <time dateTime={line.occurredAt}>{orgTime.dateTime(line.occurredAt)}</time>
                {' · '}
                {line.actor}
                {line.offline ? (
                  <>
                    {' '}
                    <Badge tone="info" label={t('workLogs.history.offline')} />
                  </>
                ) : null}
              </p>
            </li>
          );
        })}
      </ol>
      {history?.truncated ? (
        <p className={styles.hint}>{t('workLogs.history.truncated', { count: items.length })}</p>
      ) : null}
    </>
  );
}
