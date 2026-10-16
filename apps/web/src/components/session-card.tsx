'use client';

import { AUTH_TEXT, roleLabel } from '@ops/shared';

import { useSignOut } from '@/hooks/use-sign-out';

import { useAuth } from './auth-provider';
import form from './form.module.css';
import styles from './session-card.module.css';

/** Who is signed in, and the two ways out. */
export function SessionCard() {
  const { state } = useAuth();
  const { busy, failure, run } = useSignOut();
  if (state.status !== 'signedIn') {
    return null;
  }
  const { user } = state;

  return (
    <section className={styles.card} aria-labelledby="session-heading">
      <h2 id="session-heading" className={styles.heading}>
        {AUTH_TEXT.signedInAs}
      </h2>
      <p className={styles.name}>{user.displayName}</p>
      <p className={styles.role}>
        <span className={styles.badge}>{roleLabel(user.role)}</span>
        <span>{user.organizationName}</span>
      </p>

      {failure !== null ? (
        <div className={form.alert} role="alert">
          <p>{failure}</p>
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={form.primary}
          disabled={busy !== null}
          onClick={() => void run('device')}
        >
          {busy === 'device' ? AUTH_TEXT.signingOut : AUTH_TEXT.signOut}
        </button>
        <button
          type="button"
          className={form.secondary}
          disabled={busy !== null}
          aria-describedby="sign-out-everywhere-hint"
          onClick={() => void run('everywhere')}
        >
          {busy === 'everywhere' ? AUTH_TEXT.signingOut : AUTH_TEXT.signOutEverywhere}
        </button>
      </div>
      <p id="sign-out-everywhere-hint" className={styles.hint}>
        {AUTH_TEXT.signOutEverywhere}: {AUTH_TEXT.signOutEverywhereHint}
      </p>
    </section>
  );
}
