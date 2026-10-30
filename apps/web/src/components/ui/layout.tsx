import type { ReactNode } from 'react';

import styles from './ui.module.css';

/** The title row of a page: the one `<h1>`, a description, and actions on the inline end. */
export function PageHeader({
  title,
  description,
  actions,
}: Readonly<{ title: string; description?: string; actions?: ReactNode }>) {
  return (
    <header className={styles.pageHeader}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {description ? <p className={styles.pageDescription}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

/**
 * The row above a table: `start` (selection count, bulk actions) and `end` (export, view
 * switch). Hidden when printing.
 */
export function Toolbar({
  start,
  end,
  label,
}: Readonly<{ start?: ReactNode; end?: ReactNode; label?: string }>) {
  return (
    <div className={styles.toolbar} aria-label={label} role={label ? 'group' : undefined}>
      <div className={styles.toolbarGroup}>{start}</div>
      <div className={styles.toolbarGroup}>{end}</div>
    </div>
  );
}
