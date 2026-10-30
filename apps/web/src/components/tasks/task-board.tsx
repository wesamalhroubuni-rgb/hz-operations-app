import { TASK_STATUSES, type Task, type TaskStatus } from '@ops/shared';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { t, type TranslationKey } from '@/i18n';

import styles from '../manage/manage.module.css';

export interface TaskCardInfo {
  assignees: string;
  place: string;
  due: string;
  overdue: boolean;
}

/**
 * The board view: one column per status (in `TASK_STATUSES` order), each a labelled region with
 * its count. No drag and drop: every card has a "Change status" button, which works with the
 * keyboard and a screen reader. Presentational (props only), so it renders in tests.
 */
export function TaskBoard({
  groups,
  info,
  canChangeStatus,
  onChangeStatus,
}: Readonly<{
  groups: Record<TaskStatus, Task[]>;
  info: (task: Task) => TaskCardInfo;
  canChangeStatus: (task: Task) => boolean;
  onChangeStatus: (task: Task) => void;
}>) {
  return (
    <div className={styles.board} role="group" aria-label={t('tasks.board.label')}>
      {TASK_STATUSES.map((status) => {
        const tasks = groups[status];
        const headingId = `board-${status}`;
        return (
          <section key={status} className={styles.boardColumn} aria-labelledby={headingId}>
            <h2 id={headingId} className={styles.boardHead} data-status={status}>
              <span>{t(`status.task.${status}` as TranslationKey)}</span>
              <span className={styles.muted}>
                {t('tasks.board.columnCount', { count: tasks.length })}
              </span>
            </h2>
            {tasks.length === 0 ? (
              <p className={styles.muted}>{t('tasks.board.columnEmpty')}</p>
            ) : (
              <ul className={styles.boardList}>
                {tasks.map((task) => {
                  const card = info(task);
                  return (
                    <li key={task.id} className={styles.taskCard} data-task-id={task.id}>
                      <Link href={`/tasks/${task.id}`} className={styles.taskCardTitle}>
                        {task.title}
                      </Link>
                      <div className={styles.row}>
                        <StatusBadge kind="priority" value={task.priority} />
                        {card.overdue ? <Badge tone="danger" label={t('tasks.overdue')} /> : null}
                        {task.archivedAt ? <StatusBadge kind="archived" /> : null}
                      </div>
                      {task.status === 'blocked' && task.statusReason ? (
                        <p className={styles.reason}>
                          {t('tasks.blockedReason', { reason: task.statusReason })}
                        </p>
                      ) : null}
                      <span className={styles.muted}>{card.assignees}</span>
                      {card.place ? <span className={styles.muted}>{card.place}</span> : null}
                      <span className={styles.muted}>{card.due}</span>
                      {canChangeStatus(task) ? (
                        <Button
                          size="sm"
                          onClick={() => onChangeStatus(task)}
                          aria-label={t('tasks.board.moveLabel', { title: task.title })}
                        >
                          {t('tasks.status.change')}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
