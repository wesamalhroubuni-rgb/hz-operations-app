'use client';

import { Fragment, useId, type ReactNode } from 'react';

import { Checkbox } from '@/components/ui/form-field';
import { t } from '@/i18n';
import { describeError } from '@/lib/api/errors';
import type { DirectoryOption } from '@/lib/directory';

import styles from './manage.module.css';

/** A short confirmation after a save ("Task created."), announced politely. */
export function Notice({ children }: Readonly<{ children: ReactNode }>) {
  if (!children) return null;
  return (
    <p className={styles.notice} role="status">
      {children}
    </p>
  );
}

/** A failed write inside a form or dialog: the sentence of `describeError` or a given one. */
export function FormAlert({
  error,
  message,
  title,
}: Readonly<{ error?: unknown; message?: string | null; title?: string }>) {
  if (!message && (error === null || error === undefined)) return null;
  return (
    <p className={styles.alert} role="alert">
      {title ? <strong className={styles.alertTitle}>{title}</strong> : null}
      {message ?? describeError(error)}
    </p>
  );
}

/** A warning that does not block (e.g. "removed fields stay in older logs"). */
export function Warning({ children }: Readonly<{ children: ReactNode }>) {
  return <p className={styles.warning}>{children}</p>;
}

/**
 * A labelled list of checkboxes for picking several ids (assignees, sites, teams). Archived
 * entries are hidden unless already selected, so an old choice is never silently dropped.
 */
export function CheckList({
  legend,
  options,
  selected,
  onChange,
  hint,
  error,
  emptyLabel = t('common.none'),
}: Readonly<{
  legend: string;
  options: readonly DirectoryOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  hint?: string;
  error?: string | null;
  emptyLabel?: string;
}>) {
  const id = useId();
  const visible = options.filter((option) => !option.archived || selected.includes(option.value));
  const toggle = (value: string) =>
    onChange(
      selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
    );
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <fieldset className={styles.fieldset} aria-describedby={described || undefined}>
      <legend className={styles.legend}>{legend}</legend>
      {visible.length === 0 ? (
        <p className={styles.muted}>{emptyLabel}</p>
      ) : (
        <ul className={styles.checkList}>
          {visible.map((option) => (
            <li key={option.value}>
              <Checkbox
                label={option.archived ? `${option.label} (${t('status.archived')})` : option.label}
                checked={selected.includes(option.value)}
                onChange={() => toggle(option.value)}
              />
            </li>
          ))}
        </ul>
      )}
      {hint ? (
        <p id={`${id}-hint`} className={styles.muted}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className={styles.alert}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Label / value pairs (a `<dl>`). */
export function DetailList({
  items,
}: Readonly<{ items: readonly { label: string; value: ReactNode }[] }>) {
  return (
    <dl className={styles.details}>
      {items.map((item) => (
        <Fragment key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
