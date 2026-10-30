import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import styles from './ui.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

function classes(variant: ButtonVariant, size: 'md' | 'sm', extra?: string): string {
  return [
    styles.button,
    variant === 'primary' && styles.primary,
    variant === 'danger' && styles.danger,
    variant === 'ghost' && styles.ghost,
    size === 'sm' && styles.small,
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Disables the button and announces it as busy (shows `busyLabel` when given). */
  busy?: boolean;
  busyLabel?: string;
}

/** A button. `type` defaults to `button`, so it never submits a form by accident. */
export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  busyLabel,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: Readonly<ButtonProps>) {
  return (
    <button
      {...rest}
      type={type}
      className={classes(variant, size, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

/** A link styled as a button (navigation, not an action). */
export function ButtonLink({
  href,
  variant = 'secondary',
  size = 'md',
  children,
}: Readonly<{ href: string; variant?: ButtonVariant; size?: 'md' | 'sm'; children: ReactNode }>) {
  return (
    <Link href={href} className={classes(variant, size)}>
      {children}
    </Link>
  );
}
