'use client';

import { AUTH_TEXT } from '@ops/shared';
import { useId, useState, type InputHTMLAttributes, type Ref } from 'react';

import styles from './form.module.css';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Shown under the field and announced with it. */
  error?: string;
  /** A standing hint, such as the password policy. */
  hint?: string;
  inputRef?: Ref<HTMLInputElement>;
}

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const present = ids.filter(Boolean);
  return present.length > 0 ? present.join(' ') : undefined;
}

/** A labelled text input with its hint and its error. */
export function TextField({
  label,
  value,
  onValueChange,
  error,
  hint,
  inputRef,
  ...input
}: Readonly<FieldProps>) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        {...input}
        ref={inputRef}
        id={id}
        className={styles.input}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)}
      />
      {hint ? (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className={styles.fieldError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A password input with a button that shows or hides what was typed. */
export function PasswordField({
  label,
  value,
  onValueChange,
  error,
  hint,
  inputRef,
  ...input
}: Readonly<FieldProps>) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.passwordRow}>
        <input
          {...input}
          ref={inputRef}
          id={id}
          className={styles.input}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)}
        />
        <button
          type="button"
          className={styles.toggle}
          aria-controls={id}
          aria-label={`${visible ? AUTH_TEXT.hidePasswordLabel : AUTH_TEXT.showPasswordLabel}: ${label}`}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? AUTH_TEXT.hidePassword : AUTH_TEXT.showPassword}
        </button>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className={styles.fieldError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
