'use client';

import Link from 'next/link';

import { useLoginForm } from '@/hooks/use-login-form';
import { t } from '@/i18n';
import { translateAuthText } from '@/lib/auth-text';
import { ACTIVATE_PATH } from '@/lib/auth/routes';

import { useAuth } from './auth-provider';
import { PasswordField, TextField } from './form-fields';
import styles from './form.module.css';

export function LoginForm({ passwordSet }: Readonly<{ passwordSet: boolean }>) {
  const { state, retry } = useAuth();
  const form = useLoginForm();
  const notice = state.status === 'signedOut' ? state.notice : null;

  return (
    <>
      {passwordSet && form.failure === null ? (
        <div className={styles.success} role="status">
          <p>{t('auth.passwordSet')}</p>
        </div>
      ) : null}

      {notice !== null && form.failure === null ? (
        <div className={styles.notice} role="status">
          <p>{t(`authNotices.${notice}`)}</p>
          {notice === 'unreachable' ? (
            <button type="button" className={styles.inline} onClick={retry}>
              {t('auth.retry')}
            </button>
          ) : null}
        </div>
      ) : null}

      {form.failure !== null ? (
        <div className={styles.alert} role="alert">
          <p>{form.failure}</p>
        </div>
      ) : null}

      <form className={styles.form} onSubmit={form.submit} noValidate aria-busy={form.submitting}>
        <TextField
          label={t('auth.identifierLabel')}
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
          value={form.identifier}
          onValueChange={form.setIdentifier}
          error={translateAuthText(form.errors.identifier)}
          inputRef={form.identifierRef}
        />
        <PasswordField
          label={t('auth.passwordLabel')}
          name="password"
          autoComplete="current-password"
          required
          value={form.password}
          onValueChange={form.setPassword}
          error={translateAuthText(form.errors.password)}
          inputRef={form.passwordRef}
        />
        <button type="submit" className={styles.primary} disabled={form.submitting}>
          {form.submitting ? t('auth.signingIn') : t('auth.signIn')}
        </button>
      </form>

      <p className={styles.footerLink}>
        <Link href={ACTIVATE_PATH}>{t('auth.haveCode')}</Link>
      </p>
    </>
  );
}
