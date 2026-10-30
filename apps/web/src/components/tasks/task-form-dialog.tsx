'use client';

import { TASK_PRIORITIES, type Task, type TaskPriority } from '@ops/shared';
import { useState, type FormEvent } from 'react';

import { CheckList, FormAlert } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form-field';
import { useDirectory } from '@/hooks/use-directory';
import { useOrgTime } from '@/hooks/use-organization';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { ApiCallError, unwrap } from '@/lib/api/errors';
import type { DirectoryOption } from '@/lib/directory';
import {
  createTaskBody,
  editTaskBodies,
  emptyTaskForm,
  taskFormFrom,
  taskWriteRefusal,
  type FormErrors,
  type TaskFormState,
} from '@/lib/tasks';

import styles from '../manage/manage.module.css';
import { useTaskSaved } from './use-tasks';

/** Active options, plus the current value when it is archived (so it is not dropped). */
export function activeOptions(options: readonly DirectoryOption[], current: string) {
  return options
    .filter((option) => !option.archived || option.value === current)
    .map((option) => ({
      value: option.value,
      label: option.archived ? `${option.label} (${t('status.archived')})` : option.label,
    }));
}

/**
 * Create a task, or edit one (fields, then assignees). Site, team and assignee pickers list only
 * what the caller can see (`GET /directory`); the API still refuses a reference outside a
 * supervisor's scope (422), shown as a sentence.
 */
export function TaskFormDialog({
  task,
  mode,
  onClose,
  onDone,
}: Readonly<{
  task: Task | null;
  /** `assign`: only the assignees (Reassign). */
  mode: 'create' | 'edit' | 'assign';
  onClose: () => void;
  onDone?: (task: Task, message: string) => void;
}>) {
  const directory = useDirectory();
  const orgTime = useOrgTime();
  const saved = useTaskSaved();
  const [form, setForm] = useState<TaskFormState>(() =>
    task ? taskFormFrom(task, orgTime.timeZone) : emptyTaskForm(),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<{ error: unknown; message: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <Key extends keyof TaskFormState>(key: Key, value: TaskFormState[Key]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFailure(null);
    setNotice(null);
    const api = requireApiClient().tasks;
    const invalidDue = t('tasks.form.invalidDue');
    setBusy(true);
    try {
      if (mode === 'create' || task === null) {
        const built = createTaskBody(form, orgTime.timeZone, invalidDue);
        if (!built.ok) {
          setErrors(built.errors);
          return;
        }
        const created = unwrap(await api.create(built.body));
        await saved(created);
        onDone?.(created, t('tasks.form.created'));
        onClose();
        return;
      }
      const built = editTaskBodies(
        task,
        mode === 'assign'
          ? { ...taskFormFrom(task, orgTime.timeZone), assigneeIds: form.assigneeIds }
          : form,
        orgTime.timeZone,
        invalidDue,
      );
      if (!built.ok) {
        setErrors(built.errors);
        return;
      }
      if (built.body.update === null && built.body.assigneeIds === null) {
        setNotice(t('tasks.form.nothingChanged'));
        return;
      }
      let latest = task;
      if (built.body.update) {
        latest = unwrap(await api.update(task.id, built.body.update));
      }
      if (built.body.assigneeIds) {
        latest = unwrap(await api.setAssignees(task.id, { assigneeIds: built.body.assigneeIds }));
      }
      await saved(latest);
      onDone?.(latest, mode === 'assign' ? t('tasks.reassigned') : t('tasks.form.saved'));
      onClose();
    } catch (error) {
      const refusal = taskWriteRefusal(error);
      const message =
        refusal === 'other' || refusal === 'version_conflict'
          ? null
          : t(`tasks.refused.${refusal}` as TranslationKey);
      if (error instanceof ApiCallError && error.status === 400) {
        setFailure({ error, message: null });
      } else {
        setFailure({ error, message });
      }
      if (task) await saved(null);
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === 'create'
      ? t('tasks.form.createTitle')
      : mode === 'assign'
        ? t('tasks.reassignTitle')
        : t('tasks.form.editTitle');
  const formId = 'task-form';

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={title}
      size={mode === 'assign' ? 'sm' : 'lg'}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            busy={busy}
            busyLabel={t('common.saving')}
          >
            {mode === 'create' ? t('tasks.form.submitCreate') : t('tasks.form.submitEdit')}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.formStack} onSubmit={submit} noValidate>
        {mode !== 'assign' ? (
          <>
            <FormField label={t('tasks.form.title')} required error={errors.title}>
              {(control) => (
                <Input
                  {...control}
                  value={form.title}
                  maxLength={200}
                  autoFocus
                  onChange={(event) => set('title', event.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('tasks.form.description')} error={errors.description}>
              {(control) => (
                <Textarea
                  {...control}
                  value={form.description}
                  maxLength={10000}
                  onChange={(event) => set('description', event.target.value)}
                />
              )}
            </FormField>
            <div className={styles.formGrid}>
              <FormField label={t('tasks.form.priority')} error={errors.priority}>
                {(control) => (
                  <Select
                    {...control}
                    value={form.priority}
                    options={TASK_PRIORITIES.map((value) => ({
                      value,
                      label: t(`priority.${value}` as TranslationKey),
                    }))}
                    onChange={(event) => set('priority', event.target.value as TaskPriority)}
                  />
                )}
              </FormField>
              <FormField
                label={t('tasks.form.due')}
                hint={t('tasks.form.dueHint', { timeZone: orgTime.timeZone })}
                error={errors.due}
              >
                {(control) => (
                  <Input
                    {...control}
                    type="datetime-local"
                    value={form.due}
                    onChange={(event) => set('due', event.target.value)}
                  />
                )}
              </FormField>
              <FormField label={t('tasks.form.site')} error={errors.siteId}>
                {(control) => (
                  <Select
                    {...control}
                    value={form.siteId}
                    placeholder={t('common.none')}
                    options={activeOptions(directory.options.sites, form.siteId)}
                    onChange={(event) => set('siteId', event.target.value)}
                  />
                )}
              </FormField>
              <FormField label={t('tasks.form.team')} error={errors.teamId}>
                {(control) => (
                  <Select
                    {...control}
                    value={form.teamId}
                    placeholder={t('common.none')}
                    options={activeOptions(directory.options.teams, form.teamId)}
                    onChange={(event) => set('teamId', event.target.value)}
                  />
                )}
              </FormField>
            </div>
          </>
        ) : null}
        <CheckList
          legend={t('tasks.form.assignees')}
          hint={t('tasks.form.assigneesHint')}
          options={directory.options.users}
          selected={form.assigneeIds}
          onChange={(next) => set('assigneeIds', next)}
          error={errors.assigneeIds}
          emptyLabel={t('tasks.form.noPeople')}
        />
        {notice ? (
          <p className={styles.muted} role="status">
            {notice}
          </p>
        ) : null}
        {failure ? <FormAlert error={failure.error} message={failure.message} /> : null}
      </form>
    </Modal>
  );
}
