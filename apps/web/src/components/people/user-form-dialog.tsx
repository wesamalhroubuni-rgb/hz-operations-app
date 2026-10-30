'use client';

import { SUPPORTED_LOCALES, type Locale, type User, type UserFull } from '@ops/shared';
import { useState, type FormEvent } from 'react';

import { FormAlert } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Select } from '@/components/ui/form-field';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { ApiCallError, unwrap } from '@/lib/api/errors';
import {
  emptyUserForm,
  inviteUser,
  updateUserBody,
  userFormFrom,
  type EditableUserField,
  type FormErrors,
  type OneTimeCode,
  type UserFormState,
} from '@/lib/people';

import styles from '../manage/manage.module.css';
import { usePeopleChanged } from './use-people';

/** Field errors from an API 400/422 (`details[].path`), else none. */
function detailErrors(error: unknown): FormErrors {
  const errors: FormErrors = {};
  if (error instanceof ApiCallError && error.failure.kind === 'http') {
    for (const detail of error.failure.error.details ?? []) {
      errors[detail.path.split('.')[0] ?? 'form'] ??= detail.message;
    }
  }
  return errors;
}

/**
 * Invite a person (`POST /users`, admins) or edit a profile (`PATCH /users/:id`, only the
 * fields the caller may change). After an invite the activation code goes to `onInvited`,
 * which shows it once; it is never cached.
 */
export function UserFormDialog({
  user,
  editable,
  onClose,
  onInvited,
  onSaved,
}: Readonly<{
  /** Null: invite. */
  user: User | null;
  editable: readonly EditableUserField[];
  onClose: () => void;
  onInvited?: (user: UserFull, code: OneTimeCode) => void;
  onSaved?: (message: string) => void;
}>) {
  const changed = usePeopleChanged();
  const [form, setForm] = useState<UserFormState>(() =>
    user ? userFormFrom(user) : emptyUserForm(),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const can = (field: EditableUserField) => user === null || editable.includes(field);
  const set = <Key extends keyof UserFormState>(key: Key, value: UserFormState[Key]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFailure(null);
    setNotice(null);
    setBusy(true);
    try {
      const api = requireApiClient().users;
      if (user === null) {
        const outcome = await inviteUser(api, form);
        if (outcome.kind === 'invalid') {
          setErrors(outcome.errors);
        } else if (outcome.kind === 'failed') {
          setErrors(detailErrors(outcome.error));
          setFailure(outcome.error);
        } else {
          await changed();
          if (outcome.user) onInvited?.(outcome.user, outcome.code);
          onClose();
        }
        return;
      }
      const built = updateUserBody(user, form, editable);
      if (!built.ok) {
        setErrors(built.errors);
        return;
      }
      if (built.body === null) {
        setNotice(t('people.form.nothingChanged'));
        return;
      }
      unwrap(await api.update(user.id, built.body));
      await changed();
      onSaved?.(t('people.form.saved'));
      onClose();
    } catch (error) {
      setErrors(detailErrors(error));
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  const formId = 'user-form';
  const text = (field: 'displayName' | 'email' | 'phone' | 'username', type = 'text') => (
    <FormField
      label={t(`people.form.${field}` as TranslationKey)}
      required={field === 'displayName'}
      error={errors[field]}
    >
      {(control) => (
        <Input
          {...control}
          type={type}
          value={form[field]}
          maxLength={field === 'email' ? 320 : 200}
          disabled={!can(field)}
          autoComplete="off"
          onChange={(event) => set(field, event.target.value)}
        />
      )}
    </FormField>
  );

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={user === null ? t('people.form.inviteTitle') : t('people.form.editTitle')}
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
            {user === null ? t('people.form.submitInvite') : t('people.form.submitEdit')}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.formStack} onSubmit={submit} noValidate>
        {text('displayName')}
        {can('email') || can('phone') || can('username') ? (
          <>
            <p className={styles.muted}>{t('people.form.identifiersHint')}</p>
            {text('email', 'email')}
            {text('phone', 'tel')}
            {text('username')}
          </>
        ) : null}
        <FormField label={t('people.form.locale')} error={errors.locale}>
          {(control) => (
            <Select
              {...control}
              value={form.locale}
              disabled={!can('locale')}
              options={SUPPORTED_LOCALES.map((value) => ({
                value,
                label: t(`people.locales.${value}` as TranslationKey),
              }))}
              onChange={(event) => set('locale', event.target.value as Locale)}
            />
          )}
        </FormField>
        {notice ? (
          <p className={styles.muted} role="status">
            {notice}
          </p>
        ) : null}
        {failure ? <FormAlert error={failure} /> : null}
        {errors.form ? <FormAlert message={errors.form} /> : null}
      </form>
    </Modal>
  );
}
