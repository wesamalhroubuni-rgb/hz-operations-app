'use client';

import { TASK_STATUSES, type Task, type TaskStatus } from '@ops/shared';
import { useState } from 'react';

import { FormAlert } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Select, Textarea } from '@/components/ui/form-field';
import { StatusBadge } from '@/components/ui/status-badge';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { statusNeedsReason, submitTaskStatusChange, type TaskWriteRefusal } from '@/lib/tasks';

import styles from '../manage/manage.module.css';
import { useTaskSaved } from './use-tasks';

/**
 * Change a task's status (and, for `cancel`, cancel it with a reason). The request carries the
 * task's `version` as `expectedVersion`; when somebody changed the task meanwhile the API
 * answers 409 `version_conflict`, the task is reloaded and the dialog explains it and stays
 * open, so the user decides again on the current state.
 */
export function TaskStatusDialog({
  task,
  mode = 'status',
  onClose,
  onDone,
}: Readonly<{
  task: Task;
  mode?: 'status' | 'cancel';
  onClose: () => void;
  onDone?: (message: string) => void;
}>) {
  const saved = useTaskSaved();
  const [status, setStatus] = useState<TaskStatus>(
    mode === 'cancel' ? 'cancelled' : task.status === 'todo' ? 'in_progress' : task.status,
  );
  const [reason, setReason] = useState(task.status === status ? (task.statusReason ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [refused, setRefused] = useState<{ refusal: TaskWriteRefusal; error: unknown } | null>(
    null,
  );
  // The latest version known to the dialog: the prop, or the reloaded task after a conflict.
  const [current, setCurrent] = useState<Task>(task);
  const [lastProp, setLastProp] = useState(task);
  if (task !== lastProp) {
    setLastProp(task);
    if (task.version >= current.version) setCurrent(task);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setReasonError(null);
    setRefused(null);
    try {
      const outcome = await submitTaskStatusChange(
        requireApiClient().tasks,
        current,
        status,
        reason,
      );
      switch (outcome.kind) {
        case 'changed':
          await saved(outcome.task);
          onDone?.(mode === 'cancel' ? t('tasks.cancel.done') : t('tasks.status.changed'));
          onClose();
          return;
        case 'invalid':
          setReasonError(t('tasks.status.reasonRequired'));
          return;
        case 'conflict':
          setConflict(true);
          if (outcome.latest) {
            setCurrent(outcome.latest);
            await saved(outcome.latest);
          }
          return;
        case 'refused':
          setRefused({ refusal: outcome.refusal, error: outcome.error });
          return;
      }
    } catch (error) {
      setRefused({ refusal: 'other', error });
    } finally {
      setBusy(false);
    }
  }

  const needsReason = statusNeedsReason(status);
  const refusedMessage =
    refused && refused.refusal !== 'other' && refused.refusal !== 'version_conflict'
      ? t(`tasks.refused.${refused.refusal}` as TranslationKey)
      : null;

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={mode === 'cancel' ? t('tasks.cancel.title') : t('tasks.status.dialogTitle')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={mode === 'cancel' ? 'danger' : 'primary'}
            onClick={submit}
            busy={busy}
            busyLabel={t('common.saving')}
            disabled={status === current.status && reason.trim() === (current.statusReason ?? '')}
          >
            {mode === 'cancel' ? t('tasks.cancel.confirm') : t('tasks.status.submit')}
          </Button>
        </>
      }
    >
      <div className={styles.formStack}>
        <p className={styles.small}>
          <strong>{current.title}</strong> · <StatusBadge kind="task" value={current.status} />
        </p>
        {mode === 'cancel' ? (
          <p className={styles.muted}>{t('tasks.cancel.description')}</p>
        ) : (
          <FormField label={t('tasks.status.newStatus')} required>
            {(control) => (
              <Select
                {...control}
                value={status}
                options={TASK_STATUSES.map((value) => ({
                  value,
                  label: t(`status.task.${value}` as TranslationKey),
                }))}
                onChange={(event) => setStatus(event.target.value as TaskStatus)}
              />
            )}
          </FormField>
        )}
        <FormField
          label={t('tasks.status.reason')}
          hint={t('tasks.status.reasonHint')}
          required={needsReason}
          error={reasonError}
        >
          {(control) => (
            <Textarea
              {...control}
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
        {conflict ? (
          <FormAlert title={t('tasks.conflict.title')} message={t('tasks.conflict.body')} />
        ) : null}
        {refused ? <FormAlert error={refused.error} message={refusedMessage} /> : null}
      </div>
    </Modal>
  );
}
