'use client';

import type { CustomFieldType, LogType } from '@ops/shared';
import { useReducer, useRef, useState, type FormEvent } from 'react';

import { FormAlert, Notice, Warning } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Modal } from '@/components/ui/dialog';
import { Checkbox, FormField, Input, Textarea } from '@/components/ui/form-field';
import { Toolbar } from '@/components/ui/layout';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import {
  createLogTypeBody,
  editorFieldsFrom,
  editorPayload,
  editorReducer,
  fieldsChanged,
  removedFieldKeys,
  suggestFieldKey,
  updateLogTypeBody,
  versionAfterSave,
  type EditorAction,
  type FieldErrors,
} from '@/lib/log-type-editor';

import styles from '../manage/manage.module.css';
import { CustomFieldEditor } from './custom-field-editor';
import { useAllLogTypes, useStructureChanged } from './use-structure';

/** Log types: list with version and field count; managers and admins create, edit, archive. */
export function LogTypesPanel({ canManage }: Readonly<{ canManage: boolean }>) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const query = useAllLogTypes(includeArchived);
  const changed = useStructureChanged();
  const [editing, setEditing] = useState<LogType | 'new' | null>(null);
  const [archiving, setArchiving] = useState<LogType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function archive() {
    if (!archiving) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(await requireApiClient().logTypes.archive(archiving.id));
      await changed('logTypes');
      setNotice(t('structure.logTypes.archived'));
      setArchiving(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const items = [...(query.data?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={styles.stack}>
      <Toolbar
        start={
          <Checkbox
            label={t('structure.showArchived')}
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
        }
        end={
          canManage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              {t('structure.logTypes.create')}
            </Button>
          ) : null
        }
      />
      <Notice>{notice}</Notice>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('structure.logTypes.empty')} />
      ) : (
        <table className={styles.diff}>
          <caption className={styles.legend}>{t('structure.logTypes.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('structure.logTypes.name')}</th>
              <th scope="col">{t('structure.logTypes.key')}</th>
              <th scope="col">{t('structure.fields.title')}</th>
              {canManage ? <th scope="col">{t('tasks.columns.actions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((logType) => (
              <tr key={logType.id}>
                <td>
                  <span className={styles.treeName}>
                    <strong>{logType.name}</strong>
                    <Badge
                      tone="info"
                      label={t('structure.logTypes.version', { version: logType.version })}
                    />
                    {logType.archivedAt ? <StatusBadge kind="archived" /> : null}
                  </span>
                </td>
                <td className={styles.mono}>{logType.key}</td>
                <td>{t('structure.logTypes.fieldCount', { count: logType.fields.length })}</td>
                {canManage ? (
                  <td>
                    {logType.archivedAt === null ? (
                      <div className={styles.row}>
                        <Button
                          size="sm"
                          onClick={() => setEditing(logType)}
                          aria-label={t('structure.place.edit', { name: logType.name })}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setError(null);
                            setArchiving(logType);
                          }}
                          aria-label={t('structure.place.archive', { name: logType.name })}
                        >
                          {t('common.archive')}
                        </Button>
                      </div>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <LogTypeDialog
          logType={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={setNotice}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        title={t('structure.logTypes.archiveTitle', { name: archiving?.name ?? '' })}
        description={t('structure.logTypes.archiveDescription')}
        confirmLabel={t('common.archive')}
        tone="danger"
        busy={busy}
        onConfirm={() => void archive()}
        onCancel={() => {
          setArchiving(null);
          setError(null);
        }}
      >
        {error ? <FormAlert error={error} /> : null}
      </ConfirmDialog>
    </div>
  );
}

/**
 * Create a log type, or edit one with the field editor. Saving a changed field list sends the
 * whole list; the API raises `version` by one (the dialog says which version it becomes).
 */
function LogTypeDialog({
  logType,
  onClose,
  onSaved,
}: Readonly<{ logType: LogType | null; onClose: () => void; onSaved: (message: string) => void }>) {
  const changed = useStructureChanged();
  const [key, setKey] = useState(logType?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(logType !== null);
  const [name, setName] = useState(logType?.name ?? '');
  const [description, setDescription] = useState(logType?.description ?? '');
  const [fields, dispatchRaw] = useReducer(editorReducer, logType?.fields ?? [], editorFieldsFrom);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, FieldErrors>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);

  function dispatch(action: EditorAction) {
    dispatchRaw(action);
    if (action.type === 'move') {
      const index = fields.findIndex((field) => field.uid === action.uid);
      const field = fields[index];
      const target = index + action.delta;
      if (field && target >= 0 && target < fields.length) {
        setAnnouncement(
          t('structure.fields.moved', {
            name: field.label.trim() || t('structure.fields.untitled'),
            position: target + 1,
          }),
        );
      }
    }
  }

  const stored = logType?.fields ?? [];
  const willChange = logType !== null && fieldsChanged(stored, editorPayload(fields));
  const removed = logType ? removedFieldKeys(stored, fields) : [];
  const storedTypes: Record<string, CustomFieldType> = Object.fromEntries(
    stored.map((field) => [field.key, field.type]),
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFieldErrors({});
    setFailure(null);
    setNotice(null);
    const api = requireApiClient().logTypes;
    if (logType === null) {
      const built = createLogTypeBody({ key, name, description }, fields);
      if (!built.ok) {
        setErrors(built.errors);
        setFieldErrors(built.fieldErrors);
        return;
      }
      setBusy(true);
      try {
        unwrap(await api.create(built.body));
        await changed('logTypes');
        onSaved(t('structure.logTypes.saved'));
        onClose();
      } catch (error) {
        setFailure(error);
      } finally {
        setBusy(false);
      }
      return;
    }
    const built = updateLogTypeBody(logType, { name, description }, fields);
    if (!built.ok) {
      setErrors(built.errors);
      setFieldErrors(built.fieldErrors);
      return;
    }
    if (built.body === null) {
      setNotice(t('structure.logTypes.nothingChanged'));
      return;
    }
    const body = built.body;
    setBusy(true);
    try {
      const saved = unwrap(await api.update(logType.id, body));
      await changed('logTypes');
      onSaved(
        body.fields !== undefined
          ? t('structure.logTypes.savedVersion', { version: saved.version })
          : t('structure.logTypes.saved'),
      );
      onClose();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  const formId = 'log-type-form';
  const errorText = (code: string | undefined) =>
    code === 'keyFormat'
      ? t('structure.fields.errors.keyFormat')
      : code
        ? t('structure.fields.errors.required')
        : null;

  return (
    <Modal
      open
      size="lg"
      onClose={busy ? () => {} : onClose}
      title={
        logType
          ? t('structure.logTypes.editTitle', { name: logType.name })
          : t('structure.logTypes.createTitle')
      }
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
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.formStack} onSubmit={submit} noValidate>
        {logType ? (
          <p className={styles.small}>
            <Badge
              tone="info"
              label={t('structure.logTypes.version', { version: logType.version })}
            />{' '}
            {willChange
              ? t('structure.logTypes.versionNote', {
                  next: versionAfterSave(logType, { fields: [] }),
                })
              : t('structure.logTypes.versionUnchanged', { version: logType.version })}
          </p>
        ) : null}
        <div className={styles.formGrid}>
          <FormField label={t('structure.logTypes.name')} required error={errorText(errors.name)}>
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={200}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!keyTouched) setKey(suggestFieldKey(event.target.value, new Set()));
                }}
              />
            )}
          </FormField>
          <FormField
            label={t('structure.logTypes.key')}
            hint={logType ? t('structure.logTypes.keyLocked') : t('structure.logTypes.keyHint')}
            error={errorText(errors.key)}
            required={logType === null}
          >
            {(control) => (
              <Input
                {...control}
                className={styles.mono}
                value={key}
                maxLength={64}
                readOnly={logType !== null}
                aria-readonly={logType !== null || undefined}
                onChange={(event) => {
                  if (logType) return;
                  setKeyTouched(true);
                  setKey(event.target.value.trim().toLowerCase());
                }}
              />
            )}
          </FormField>
        </div>
        <FormField label={t('structure.logTypes.description')}>
          {(control) => (
            <Textarea
              {...control}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </FormField>
        <CustomFieldEditor
          fields={fields}
          errors={fieldErrors}
          dispatch={dispatch}
          newUid={() => {
            counter.current += 1;
            return `new:${counter.current}`;
          }}
          announcement={announcement}
          storedTypes={storedTypes}
        />
        {removed.length > 0 ? (
          <Warning>{t('structure.logTypes.removedWarning', { keys: removed.join(', ') })}</Warning>
        ) : null}
        {notice ? (
          <p className={styles.muted} role="status">
            {notice}
          </p>
        ) : null}
        {errors.form ? (
          <FormAlert message={t('structure.fields.errors.invalid' as TranslationKey)} />
        ) : null}
        {failure ? <FormAlert error={failure} /> : null}
      </form>
    </Modal>
  );
}
