'use client';

import type { Task } from '@ops/shared';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/ui/dialog';
import { DetailList, FormAlert, Notice } from '@/components/manage/parts';
import { Button, ButtonLink } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/layout';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { useCaller } from '@/hooks/use-caller';
import { useDirectory } from '@/hooks/use-directory';
import { useOrgTime } from '@/hooks/use-organization';
import { t } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { isOverdue, taskActions, type TaskActions } from '@/lib/tasks';

import styles from '../manage/manage.module.css';
import { TaskFormDialog } from './task-form-dialog';
import { TaskHistory } from './task-history';
import { TaskStatusDialog } from './task-status-dialog';
import { useTask, useTaskSaved } from './use-tasks';

type Dialog = 'edit' | 'assign' | 'status' | 'cancel' | 'archive' | null;

/** The action buttons of a task, from `taskActions` (props only, so it renders in tests). */
export function TaskActionButtons({
  actions,
  onAction,
}: Readonly<{ actions: TaskActions; onAction: (dialog: Exclude<Dialog, null>) => void }>) {
  return (
    <>
      {actions.changeStatus ? (
        <Button variant="primary" onClick={() => onAction('status')}>
          {t('tasks.status.change')}
        </Button>
      ) : null}
      {actions.edit ? <Button onClick={() => onAction('edit')}>{t('common.edit')}</Button> : null}
      {actions.assign ? (
        <Button onClick={() => onAction('assign')}>{t('tasks.reassign')}</Button>
      ) : null}
      {actions.cancel ? (
        <Button variant="danger" onClick={() => onAction('cancel')}>
          {t('tasks.cancel.action')}
        </Button>
      ) : null}
      {actions.archive ? (
        <Button variant="ghost" onClick={() => onAction('archive')}>
          {t('common.archive')}
        </Button>
      ) : null}
    </>
  );
}

/** `/tasks/[id]`: details, blocked reason, actions and the history timeline. */
export function TaskDetailPage({ id }: Readonly<{ id: string }>) {
  const caller = useCaller();
  const directory = useDirectory();
  const orgTime = useOrgTime();
  const query = useTask(id);
  const saved = useTaskSaved();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<unknown>(null);
  const [archiving, setArchiving] = useState(false);
  const [now] = useState(() => new Date());

  if (query.isLoading) return <LoadingState />;
  if (query.error || !query.data) {
    return (
      <>
        <PageHeader
          title={t('pages.taskDetail.title')}
          actions={<ButtonLink href="/tasks">{t('tasks.detail.back')}</ButtonLink>}
        />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  }
  const task: Task = query.data;
  const actions = taskActions(caller.capabilities, task);
  const none = t('common.none');

  async function archive() {
    setArchiving(true);
    setArchiveError(null);
    try {
      const archived = unwrap(await requireApiClient().tasks.archive(task.id));
      await saved(archived);
      setNotice(t('tasks.archive.done'));
      setDialog(null);
    } catch (error) {
      setArchiveError(error);
    } finally {
      setArchiving(false);
    }
  }

  return (
    <>
      <PageHeader
        title={task.title}
        description={t('tasks.detail.version', { version: task.version })}
        actions={
          <>
            <ButtonLink href="/tasks" variant="ghost">
              {t('tasks.detail.back')}
            </ButtonLink>
            <TaskActionButtons actions={actions} onAction={setDialog} />
          </>
        }
      />
      <Notice>{notice}</Notice>
      <div className={styles.layoutTwo}>
        <section className={styles.card} aria-labelledby="task-details">
          <h2 id="task-details" className={styles.cardTitle}>
            {t('tasks.detail.details')}
          </h2>
          <div className={styles.stack}>
            <div className={styles.row}>
              <StatusBadge kind="task" value={task.status} />
              <StatusBadge kind="priority" value={task.priority} />
              {isOverdue(task, now) ? <Badge tone="danger" label={t('tasks.overdue')} /> : null}
              {task.archivedAt ? <StatusBadge kind="archived" /> : null}
            </div>
            {task.statusReason ? (
              <p className={task.status === 'blocked' ? styles.reason : styles.small}>
                {task.status === 'blocked'
                  ? t('tasks.blockedReason', { reason: task.statusReason })
                  : `${t('tasks.statusReason')}: ${task.statusReason}`}
              </p>
            ) : null}
            <DetailList
              items={[
                {
                  label: t('tasks.detail.assignees'),
                  value:
                    task.assigneeIds.length > 0
                      ? task.assigneeIds.map((assignee) => directory.user(assignee)).join(', ')
                      : t('tasks.unassigned'),
                },
                { label: t('tasks.detail.site'), value: directory.site(task.siteId) || none },
                { label: t('tasks.detail.team'), value: directory.team(task.teamId) || none },
                {
                  label: t('tasks.detail.dueAt'),
                  value: task.dueAt ? orgTime.dateTime(task.dueAt) : t('tasks.noDue'),
                },
                {
                  label: t('tasks.detail.completedAt'),
                  value: task.completedAt ? orgTime.dateTime(task.completedAt) : none,
                },
                { label: t('tasks.detail.createdBy'), value: directory.user(task.createdById) },
                { label: t('tasks.detail.createdAt'), value: orgTime.dateTime(task.createdAt) },
                { label: t('tasks.detail.updatedAt'), value: orgTime.dateTime(task.updatedAt) },
                ...(task.archivedAt
                  ? [
                      {
                        label: t('status.archived'),
                        value: t('tasks.detail.archived', {
                          date: orgTime.dateTime(task.archivedAt),
                        }),
                      },
                    ]
                  : []),
              ]}
            />
            <div>
              <h3 className={styles.legend}>{t('tasks.detail.description')}</h3>
              <p className={styles.preWrap}>
                {task.description ?? t('tasks.detail.noDescription')}
              </p>
            </div>
          </div>
        </section>
        <section className={styles.card} aria-labelledby="task-history">
          <h2 id="task-history" className={styles.cardTitle}>
            {t('tasks.history.title')}
          </h2>
          <TaskHistory taskId={task.id} />
        </section>
      </div>

      {dialog === 'edit' || dialog === 'assign' ? (
        <TaskFormDialog
          task={task}
          mode={dialog}
          onClose={() => setDialog(null)}
          onDone={(_latest, message) => setNotice(message)}
        />
      ) : null}
      {dialog === 'status' || dialog === 'cancel' ? (
        <TaskStatusDialog
          task={task}
          mode={dialog}
          onClose={() => setDialog(null)}
          onDone={setNotice}
        />
      ) : null}
      <ConfirmDialog
        open={dialog === 'archive'}
        title={t('tasks.archive.title')}
        description={t('tasks.archive.description')}
        confirmLabel={t('tasks.archive.confirm')}
        tone="danger"
        busy={archiving}
        onConfirm={() => void archive()}
        onCancel={() => {
          setDialog(null);
          setArchiveError(null);
        }}
      >
        {archiveError ? <FormAlert error={archiveError} /> : null}
      </ConfirmDialog>
    </>
  );
}
