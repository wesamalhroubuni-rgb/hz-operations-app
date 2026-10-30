'use client';

import { useState } from 'react';

import { FormAlert } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useOrgTime } from '@/hooks/use-organization';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

import styles from '../manage/manage.module.css';
import { usePeopleChanged, useUserSessions } from './use-people';

/** A user's active sessions and "sign out everywhere" (admins only). Never shows a token. */
export function SessionsPanel({
  userId,
  userName,
  onNotice,
}: Readonly<{ userId: string; userName: string; onNotice: (message: string) => void }>) {
  const sessions = useUserSessions(userId, true);
  const orgTime = useOrgTime();
  const changed = usePeopleChanged();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const result = unwrap(await requireApiClient().users.revokeSessions(userId));
      await Promise.all([changed(), sessions.refetch()]);
      onNotice(t('people.sessions.revoked', { count: result.revoked }));
      setConfirming(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const items = sessions.data?.items ?? [];
  return (
    <section aria-labelledby="sessions-title" className={styles.stack}>
      <div className={styles.row}>
        <h3 id="sessions-title" className={styles.cardTitle}>
          {t('people.sessions.title')}
        </h3>
        {items.length > 0 ? (
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            {t('people.sessions.revokeAll')}
          </Button>
        ) : null}
      </div>
      {sessions.isLoading ? (
        <LoadingState inline />
      ) : sessions.error ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('people.sessions.empty')} />
      ) : (
        <ul className={styles.boardList}>
          {items.map((session) => (
            <li key={session.id} className={styles.taskCard}>
              <strong>
                {t(`people.sessions.client.${session.client}` as TranslationKey)}
                {session.deviceName ? ` · ${session.deviceName}` : ''}
              </strong>
              {session.userAgent ? <span className={styles.muted}>{session.userAgent}</span> : null}
              <span className={styles.muted}>
                {t('people.sessions.lastUsed', { date: orgTime.dateTime(session.lastUsedAt) })}
              </span>
              <span className={styles.muted}>
                {t('people.sessions.started', { date: orgTime.dateTime(session.createdAt) })} ·{' '}
                {t('people.sessions.expires', { date: orgTime.dateTime(session.expiresAt) })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirming}
        title={t('people.sessions.revokeTitle', { name: userName })}
        description={t('people.sessions.revokeDescription')}
        confirmLabel={t('people.sessions.revokeConfirm')}
        tone="danger"
        busy={busy}
        onConfirm={() => void revoke()}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        {error ? <FormAlert error={error} /> : null}
      </ConfirmDialog>
    </section>
  );
}
