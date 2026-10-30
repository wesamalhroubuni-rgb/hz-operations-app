'use client';

import type { ReactNode } from 'react';

import { t } from '@/i18n';
import { describeError, isNotFound } from '@/lib/api/errors';

import { Button } from './button';
import styles from './ui.module.css';

/** A neutral "Loading…" with a spinner, announced politely. */
export function LoadingState({
  label = t('states.loading'),
  inline = false,
}: Readonly<{ label?: string; inline?: boolean }>) {
  return (
    <div
      className={inline ? `${styles.state} ${styles.stateInline}` : styles.state}
      role="status"
      aria-live="polite"
    >
      <span className={styles.spinner} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Nothing to show. `description` says why, `action` offers the way forward. */
export function EmptyState({
  title = t('states.emptyTitle'),
  description,
  action,
}: Readonly<{ title?: string; description?: string; action?: ReactNode }>) {
  return (
    <div className={styles.state}>
      <p className={styles.stateTitle}>{title}</p>
      {description ? <p className={styles.stateBody}>{description}</p> : null}
      {action}
    </div>
  );
}

/**
 * A failed load. A 404 reads "Not found / you cannot see it" (the API answers 404 for a record
 * outside the caller's scope, ADR-0005); everything else gets a sentence from `describeError`
 * and, when `onRetry` is given, a retry button.
 */
export function ErrorState({
  error,
  onRetry,
  title,
}: Readonly<{ error: unknown; onRetry?: () => void; title?: string }>) {
  const notFound = isNotFound(error);
  return (
    <div className={`${styles.state} ${styles.stateError}`} role="alert">
      <p className={styles.stateTitle}>
        {title ?? (notFound ? t('states.notFoundTitle') : t('states.errorTitle'))}
      </p>
      <p className={styles.stateBody}>{describeError(error)}</p>
      {onRetry && !notFound ? (
        <Button variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  );
}
