'use client';

import { TASK_HISTORY_FIELDS } from '@ops/shared';

import { Badge } from '@/components/ui/status-badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useDirectory } from '@/hooks/use-directory';
import { useOrgTime } from '@/hooks/use-organization';
import { t, type TranslationKey } from '@/i18n';
import { formatTaskHistoryValue, historyActionKey, type HistoryNames } from '@/lib/tasks';

import styles from '../manage/manage.module.css';
import { useTaskHistory } from './use-tasks';

/** The task's history (`GET /tasks/:id/history`): who changed what, when, oldest first. */
export function TaskHistory({ taskId }: Readonly<{ taskId: string }>) {
  const history = useTaskHistory(taskId);
  const directory = useDirectory();
  const orgTime = useOrgTime();

  if (history.isLoading) return <LoadingState />;
  if (history.error)
    return <ErrorState error={history.error} onRetry={() => void history.refetch()} />;
  const items = history.data?.items ?? [];
  if (items.length === 0) return <EmptyState title={t('tasks.history.empty')} />;

  const names: HistoryNames = {
    user: directory.user,
    site: directory.site,
    team: directory.team,
    dateTime: orgTime.dateTime,
    status: (value) => t(`status.task.${value}` as TranslationKey),
    priority: (value) => t(`priority.${value}` as TranslationKey),
    none: t('common.none'),
  };
  const known = new Set<string>(TASK_HISTORY_FIELDS);

  return (
    <>
      {history.data?.truncated ? (
        <p className={styles.muted}>{t('tasks.history.truncated')}</p>
      ) : null}
      <ol className={styles.timeline}>
        {items.map((entry) => {
          const actionKey = historyActionKey(entry.action);
          const changes = Object.entries(entry.changes ?? {}).filter(([field]) => known.has(field));
          return (
            <li key={entry.id} className={styles.timelineItem}>
              <div className={styles.timelineHead}>
                <strong>
                  {actionKey === 'unknown'
                    ? t('tasks.history.actions.unknownAction', { action: entry.action })
                    : t(`tasks.history.actions.${actionKey}` as TranslationKey)}
                </strong>
                <span className={styles.muted}>
                  {entry.actorType === 'system'
                    ? t('tasks.history.system')
                    : t('tasks.history.by', { name: entry.actorName ?? t('common.someone') })}
                </span>
                <time className={styles.muted} dateTime={entry.occurredAt}>
                  {orgTime.dateTime(entry.occurredAt)}
                </time>
                {entry.offline ? <Badge tone="info" label={t('tasks.history.offline')} /> : null}
              </div>
              {changes.length > 0 ? (
                <ul className={styles.timelineChanges}>
                  {changes.map(([field, change]) => (
                    <li key={field}>
                      {t('tasks.history.field', {
                        field: t(`tasks.history.fields.${field}` as TranslationKey),
                        from: formatTaskHistoryValue(field, change.from, names),
                        to: formatTaskHistoryValue(field, change.to, names),
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}
