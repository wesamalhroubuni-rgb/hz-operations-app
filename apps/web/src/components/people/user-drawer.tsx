'use client';

import type { User } from '@ops/shared';
import { useState } from 'react';

import { DetailList, FormAlert, Notice } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Drawer } from '@/components/ui/dialog';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Badge } from '@/components/ui/status-badge';
import { useCaller } from '@/hooks/use-caller';
import { useOrgTime } from '@/hooks/use-organization';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { ApiCallError, unwrap } from '@/lib/api/errors';
import {
  editableUserFields,
  issueUserCode,
  userActions,
  type OneTimeCode,
  type UserActions,
} from '@/lib/people';

import styles from '../manage/manage.module.css';
import { MembershipsPanel } from './memberships-panel';
import { OneTimeCodeDialog } from './one-time-code-dialog';
import { SessionsPanel } from './sessions-panel';
import { UserFormDialog } from './user-form-dialog';
import { usePeopleChanged, useUser } from './use-people';

type Confirm = 'activation' | 'reset' | 'archive' | null;

/** The action buttons for a user, from `userActions` (props only, so it renders in tests). */
export function UserActionButtons({
  actions,
  onAction,
}: Readonly<{
  actions: UserActions;
  onAction: (action: 'edit' | 'activation' | 'reset' | 'archive' | 'restore') => void;
}>) {
  return (
    <div className={styles.row}>
      {actions.edit ? (
        <Button onClick={() => onAction('edit')}>{t('people.actions.edit')}</Button>
      ) : null}
      {actions.issueActivationCode ? (
        <Button onClick={() => onAction('activation')}>{t('people.actions.activationCode')}</Button>
      ) : null}
      {actions.resetPassword ? (
        <Button onClick={() => onAction('reset')}>{t('people.actions.resetPassword')}</Button>
      ) : null}
      {actions.archive ? (
        <Button variant="danger" onClick={() => onAction('archive')}>
          {t('people.actions.archive')}
        </Button>
      ) : null}
      {actions.restore ? (
        <Button onClick={() => onAction('restore')}>{t('people.actions.restore')}</Button>
      ) : null}
    </div>
  );
}

function statusOf(user: User): { tone: 'success' | 'warning' | 'muted'; label: string } | null {
  if (user.profile !== 'full') return null;
  if (user.archivedAt) return { tone: 'muted', label: t('people.state.archived') };
  if (!user.activated) return { tone: 'warning', label: t('people.state.notActivated') };
  return { tone: 'success', label: t('people.state.active') };
}

/** One person: profile, admin actions, one-time codes, roles and scope, sessions. */
export function UserDrawer({ userId, onClose }: Readonly<{ userId: string; onClose: () => void }>) {
  const caller = useCaller();
  const orgTime = useOrgTime();
  const query = useUser(userId);
  const changed = usePeopleChanged();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The one code on screen. Only here, only while its dialog is open.
  const [code, setCode] = useState<OneTimeCode | null>(null);

  const user = query.data;
  const isSelf = caller.isSelf(userId);

  async function runConfirm() {
    if (!user || confirm === null) return;
    setBusy(true);
    setError(null);
    try {
      const api = requireApiClient().users;
      if (confirm === 'archive') {
        unwrap(await api.archive(user.id));
        await changed();
        setNotice(t('people.archive.done'));
      } else {
        const outcome = await issueUserCode(
          api,
          user,
          confirm === 'activation' ? 'activation' : 'password_reset',
        );
        if (outcome.kind !== 'done') {
          setError(outcome.kind === 'failed' ? outcome.error : null);
          return;
        }
        setCode(outcome.code);
      }
      setConfirm(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!user) return;
    setError(null);
    try {
      unwrap(await requireApiClient().users.restore(user.id));
      await changed();
      setNotice(t('people.restore.done'));
    } catch (failure) {
      setError(failure);
    }
  }

  const lastAdmin =
    error instanceof ApiCallError && error.status === 409
      ? t('people.memberships.lastAdmin')
      : null;

  let body;
  if (query.isLoading) body = <LoadingState />;
  else if (query.error || !user)
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else {
    const actions = userActions(caller.capabilities, user, isSelf);
    const status = statusOf(user);
    const none = t('common.none');
    body = (
      <div className={styles.stack}>
        <Notice>{notice}</Notice>
        <div className={styles.row}>
          {user.roles.length === 0 ? (
            <span className={styles.muted}>{t('people.detail.noRoles')}</span>
          ) : (
            user.roles.map((role) => (
              <Badge key={role} tone="primary" label={t(`roles.${role}` as TranslationKey)} />
            ))
          )}
          {status ? <Badge tone={status.tone} label={status.label} /> : null}
        </div>
        <UserActionButtons
          actions={actions}
          onAction={(action) => {
            setError(null);
            if (action === 'edit') setEditing(true);
            else if (action === 'restore') void restore();
            else setConfirm(action);
          }}
        />
        {error && confirm === null ? <FormAlert error={error} message={lastAdmin} /> : null}
        {user.profile === 'basic' ? (
          <p className={styles.muted}>{t('people.detail.contactHidden')}</p>
        ) : (
          <DetailList
            items={[
              { label: t('people.columns.email'), value: user.email ?? none },
              { label: t('people.columns.phone'), value: user.phone ?? none },
              ...(user.profile === 'full'
                ? [
                    { label: t('people.detail.username'), value: user.username ?? none },
                    {
                      label: t('people.detail.locale'),
                      value: t(`people.locales.${user.locale}` as TranslationKey),
                    },
                    { label: t('people.detail.created'), value: orgTime.dateTime(user.createdAt) },
                    ...(user.archivedAt
                      ? [
                          {
                            label: t('status.archived'),
                            value: t('people.detail.archivedOn', {
                              date: orgTime.dateTime(user.archivedAt),
                            }),
                          },
                        ]
                      : []),
                  ]
                : []),
            ]}
          />
        )}
        {actions.memberships ? <MembershipsPanel userId={user.id} onNotice={setNotice} /> : null}
        {actions.sessions ? (
          <SessionsPanel userId={user.id} userName={user.displayName} onNotice={setNotice} />
        ) : null}
        {editing ? (
          <UserFormDialog
            user={user}
            editable={editableUserFields(caller.capabilities, isSelf)}
            onClose={() => setEditing(false)}
            onSaved={setNotice}
          />
        ) : null}
        <ConfirmDialog
          open={confirm !== null}
          title={
            confirm === 'archive'
              ? t('people.archive.title', { name: user.displayName })
              : confirm === 'reset'
                ? t('people.reset.title', { name: user.displayName })
                : t('people.activation.title', { name: user.displayName })
          }
          description={
            confirm === 'archive'
              ? t('people.archive.description')
              : confirm === 'reset'
                ? t('people.reset.description')
                : t('people.activation.description')
          }
          confirmLabel={
            confirm === 'archive'
              ? t('people.archive.confirm')
              : confirm === 'reset'
                ? t('people.reset.confirm')
                : t('people.activation.confirm')
          }
          tone={confirm === 'archive' ? 'danger' : 'primary'}
          busy={busy}
          onConfirm={() => void runConfirm()}
          onCancel={() => {
            setConfirm(null);
            setError(null);
          }}
        >
          {error ? <FormAlert error={error} message={lastAdmin} /> : null}
        </ConfirmDialog>
        {code ? (
          <OneTimeCodeDialog
            code={code}
            expires={orgTime.dateTime(code.expiresAt)}
            onClose={() => setCode(null)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <Drawer open onClose={onClose} title={user?.displayName ?? t('people.detail.title')}>
      {body}
    </Drawer>
  );
}
