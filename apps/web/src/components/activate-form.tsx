'use client';

import { AUTH_TEXT } from '@ops/shared';
import Link from 'next/link';

import { useActivateForm } from '@/hooks/use-activate-form';
import { LOGIN_PATH } from '@/lib/auth/routes';

import { PasswordField, TextField } from './form-fields';
import styles from './form.module.css';

export function ActivateForm({ initialCode }: Readonly<{ initialCode: string }>) {
  const form = useActivateForm(initialCode);

  return (
    <>
      {form.failure !== null ? (
        <div className={styles.alert} role="alert">
          <p>{form.failure.message}</p>
          {form.failure.details.length > 0 ? (
            <ul className={styles.details}>
              {form.failure.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <form className={styles.form} onSubmit={form.submit} noValidate aria-busy={form.submitting}>
        <TextField
          label={AUTH_TEXT.codeLabel}
          name="code"
          type="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={initialCode === ''}
          required
          value={form.code}
          onValueChange={form.setCode}
          error={form.errors.code}
          inputRef={form.codeRef}
        />
        <PasswordField
          label={AUTH_TEXT.newPasswordLabel}
          name="new-password"
          autoComplete="new-password"
          autoFocus={initialCode !== ''}
          required
          hint={AUTH_TEXT.passwordPolicy}
          value={form.password}
          onValueChange={form.setPassword}
          error={form.errors.password}
          inputRef={form.passwordRef}
        />
        <PasswordField
          label={AUTH_TEXT.confirmPasswordLabel}
          name="confirm-password"
          autoComplete="new-password"
          required
          value={form.confirmation}
          onValueChange={form.setConfirmation}
          error={form.errors.confirmation}
          inputRef={form.confirmationRef}
        />
        <button type="submit" className={styles.primary} disabled={form.submitting}>
          {form.submitting ? AUTH_TEXT.settingPassword : AUTH_TEXT.setPassword}
        </button>
      </form>

      <p className={styles.footerLink}>
        <Link href={LOGIN_PATH}>{AUTH_TEXT.backToSignIn}</Link>
      </p>
    </>
  );
}
