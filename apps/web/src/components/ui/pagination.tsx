'use client';

import { formatNumber, t } from '@/i18n';
import { PAGE_SIZE_OPTIONS } from '@/lib/list-params';

import { Button } from './button';
import styles from './ui.module.css';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Shows the "Rows per page" select when given. */
  onPageSizeChange?: (pageSize: number) => void;
}

/** "26–50 of 132", Previous / Next, and the page size. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: Readonly<PaginationProps>) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className={styles.pagination} aria-label={t('table.pagination')}>
      <span aria-live="polite">
        {t('table.range', {
          from: formatNumber(from),
          to: formatNumber(to),
          total: formatNumber(total),
        })}
      </span>
      <div className={styles.paginationControls}>
        {onPageSizeChange ? (
          <label className={styles.paginationControls}>
            <span>{t('table.pageSize')}</span>
            <select
              className={`${styles.control} ${styles.pageSize}`}
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          {t('table.previous')}
        </Button>
        <span>{t('table.pageOf', { page: formatNumber(page), pages: formatNumber(pages) })}</span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          {t('table.next')}
        </Button>
      </div>
    </nav>
  );
}
