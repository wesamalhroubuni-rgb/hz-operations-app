'use client';

import { ROLES, type Membership, type Role } from '@ops/shared';
import { useState, type FormEvent } from 'react';

import { CheckList, FormAlert } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Modal } from '@/components/ui/dialog';
import { Checkbox, FormField, Select } from '@/components/ui/form-field';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Badge } from '@/components/ui/status-badge';
import { useDirectory } from '@/hooks/use-directory';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { ApiCallError, unwrap } from '@/lib/api/errors';
import {
  createMembershipBody,
  emptyMembershipForm,
  membershipFormFrom,
  roleIsOrgWide,
  updateMembershipBody,
  type MembershipFormState,
} from '@/lib/people';

import styles from '../manage/manage.module.css';
import { usePeopleChanged, useUserMemberships } from './use-people';

function conflictMessage(error: unknown): string | null {
  return error instanceof ApiCallError && error.status === 409
    ? t('people.memberships.lastAdmin')
    : null;
}

/** Roles and scope of one user (admins only): list, add, edit, remove. */
export function MembershipsPanel({
  userId,
  onNotice,
}: Readonly<{ userId: string; onNotice: (message: string) => void }>) {
  const memberships = useUserMemberships(userId, true);
  const directory = useDirectory();
  const changed = usePeopleChanged();
  const [editing, setEditing] = useState<Membership | 'new' | null>(null);
  const [removing, setRemoving] = useState<Membership | null>(null);
  const [removeError, setRemoveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setRemoveError(null);
    try {
      unwrap(await requireApiClient().memberships.archive(removing.id));
      await changed();
      onNotice(t('people.memberships.removed'));
      setRemoving(null);
    } catch (error) {
      setRemoveError(error);
    } finally {
      setBusy(false);
    }
  }

  const items = memberships.data?.items ?? [];
  const scopeText = (membership: Membership) =>
    membership.orgWide
      ? t('people.memberships.scopeOrgWide')
      : [
          ...membership.siteIds.map((id) => directory.site(id)),
          ...membership.teamIds.map((id) => directory.team(id)),
        ].join(', ');

  return (
    <section aria-labelledby="memberships-title" className={styles.stack}>
      <div className={styles.row}>
        <h3 id="memberships-title" className={styles.cardTitle}>
          {t('people.memberships.title')}
        </h3>
        <Button size="sm" onClick={() => setEditing('new')}>
          {t('people.memberships.add')}
        </Button>
      </div>
      {memberships.isLoading ? (
        <LoadingState inline />
      ) : memberships.error ? (
        <ErrorState error={memberships.error} onRetry={() => void memberships.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('people.memberships.empty')} />
      ) : (
        <ul className={styles.boardList}>
          {items.map((membership) => (
            <li key={membership.id} className={styles.taskCard}>
              <div className={styles.row}>
                <Badge tone="primary" label={t(`roles.${membership.role}` as TranslationKey)} />
                <span className={styles.small}>{scopeText(membership)}</span>
              </div>
              <div className={styles.row}>
                <Button size="sm" onClick={() => setEditing(membership)}>
                  {t('common.edit')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setRemoving(membership)}>
                  {t('people.memberships.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <MembershipDialog
          userId={userId}
          membership={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => onNotice(t('people.memberships.saved'))}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={t('people.memberships.removeTitle')}
        description={t('people.memberships.removeDescription')}
        confirmLabel={t('people.memberships.remove')}
        tone="danger"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => {
          setRemoving(null);
          setRemoveError(null);
        }}
      >
        {removeError ? (
          <FormAlert error={removeError} message={conflictMessage(removeError)} />
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

/** The role + scope editor. Managers and admins are always organization-wide. */
export function MembershipDialog({
  userId,
  membership,
  onClose,
  onSaved,
}: Readonly<{
  userId: string;
  membership: Membership | null;
  onClose: () => void;
  onSaved: () => void;
}>) {
  const directory = useDirectory();
  const changed = usePeopleChanged();
  const [form, setForm] = useState<MembershipFormState>(() =>
    membership ? membershipFormFrom(membership) : emptyMembershipForm(),
  );
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const forced = roleIsOrgWide(form.role);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setScopeError(null);
    setFailure(null);
    const update = membership ? updateMembershipBody(form) : null;
    const create = membership ? null : createMembershipBody(userId, form);
    const built = update ?? create;
    if (built && !built.ok) {
      setScopeError(
        built.errors.scope
          ? t('people.memberships.scopeRequired')
          : (Object.values(built.errors)[0] ?? null),
      );
      return;
    }
    setBusy(true);
    try {
      const api = requireApiClient().memberships;
      if (membership && update?.ok) {
        unwrap(await api.update(membership.id, update.body));
      } else if (create?.ok) {
        unwrap(await api.create(create.body));
      }
      await changed();
      onSaved();
      onClose();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  const formId = 'membership-form';
  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={membership ? t('people.memberships.editTitle') : t('people.memberships.addTitle')}
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
        <FormField label={t('people.memberships.role')} required>
          {(control) => (
            <Select
              {...control}
              value={form.role}
              options={ROLES.map((value) => ({
                value,
                label: t(`roles.${value}` as TranslationKey),
              }))}
              onChange={(event) =>
                setForm((current) => ({ ...current, role: event.target.value as Role }))
              }
            />
          )}
        </FormField>
        {forced ? (
          <p className={styles.muted}>{t('people.memberships.orgWideForced')}</p>
        ) : (
          <>
            <Checkbox
              label={t('people.memberships.orgWide')}
              checked={form.orgWide}
              onChange={(event) =>
                setForm((current) => ({ ...current, orgWide: event.target.checked }))
              }
            />
            {!form.orgWide ? (
              <div className={styles.formGrid}>
                <CheckList
                  legend={t('people.memberships.sites')}
                  options={directory.options.sites}
                  selected={form.siteIds}
                  onChange={(siteIds) => setForm((current) => ({ ...current, siteIds }))}
                  emptyLabel={t('people.memberships.noPlaces')}
                />
                <CheckList
                  legend={t('people.memberships.teams')}
                  options={directory.options.teams}
                  selected={form.teamIds}
                  onChange={(teamIds) => setForm((current) => ({ ...current, teamIds }))}
                  emptyLabel={t('people.memberships.noPlaces')}
                />
              </div>
            ) : null}
          </>
        )}
        {scopeError ? <FormAlert message={scopeError} /> : null}
        {failure ? <FormAlert error={failure} message={conflictMessage(failure)} /> : null}
      </form>
    </Modal>
  );
}
