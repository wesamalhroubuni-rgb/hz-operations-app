'use client';

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useMemo, type ReactNode } from 'react';

import { t } from '@/i18n';
import type { ListState, ListStateChange } from '@/lib/list-params';

import styles from './data-table.module.css';
import { Pagination } from './pagination';
import { EmptyState, ErrorState, LoadingState } from './states';

/** Row selection for bulk actions (e.g. bulk approve). */
export interface TableSelection<Row> {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Rows that may not be selected get a disabled checkbox (e.g. the caller's own logs). */
  isSelectable?: (row: Row) => boolean;
}

export interface DataTableProps<Row> {
  /**
   * TanStack Table column definitions. A column's `id` (or `accessorKey`) that appears in
   * `sortableFields` sorts by that API field (`?sort=<id>:asc`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<Row, any>[];
  data: readonly Row[] | undefined;
  getRowId: (row: Row) => string;
  /** Accessible name of the table (screen readers), e.g. "Work logs". */
  caption: string;
  /** The URL-synced list state (`useListParams`): sort and pagination go through it. */
  list?: { state: ListState; change: (change: ListStateChange) => void };
  /** Total rows on the server, for pagination. Omit to hide pagination. */
  total?: number;
  /** API sort fields the user may sort by (e.g. `WORK_LOG_SORT_FIELDS`). */
  sortableFields?: readonly string[];
  /** First load (no data yet): shows the loading state. */
  loading?: boolean;
  /** A refresh is running while old data is shown: the table dims. */
  fetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Shown when the page has no rows. */
  empty?: ReactNode;
  selection?: TableSelection<Row>;
}

/**
 * The dashboard's table (ADR-0009): TanStack Table v8 headless, in MANUAL mode: sorting,
 * filtering and pagination happen on the server, and their state lives in the page URL. The
 * table only renders the current page and turns header clicks and page buttons into
 * `list.change(...)`. Loading, empty and error states are built in.
 */
export function DataTable<Row>({
  columns,
  data,
  getRowId,
  caption,
  list,
  total,
  sortableFields = [],
  loading = false,
  fetching = false,
  error,
  onRetry,
  empty,
  selection,
}: Readonly<DataTableProps<Row>>) {
  const sorting = useMemo<SortingState>(
    () =>
      list?.state.sort
        ? [{ id: list.state.sort.field, desc: list.state.sort.direction === 'desc' }]
        : [],
    [list?.state.sort],
  );
  const rows = useMemo(() => (data ? [...data] : []), [data]);

  // TanStack Table's functions cannot be memoized by the React Compiler; the table object is
  // only used during this render, never passed to a memoized child.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
    state: { sorting },
  });

  const selectableRows = selection
    ? rows.filter((row) => selection.isSelectable?.(row) ?? true)
    : [];
  const allSelected =
    selectableRows.length > 0 &&
    selectableRows.every((row) => selection?.selected.has(getRowId(row)));

  function toggleAll() {
    if (!selection) return;
    const next = new Set(selection.selected);
    for (const row of selectableRows) {
      if (allSelected) next.delete(getRowId(row));
      else next.add(getRowId(row));
    }
    selection.onChange(next);
  }

  function toggleRow(id: string) {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  }

  function cycleSort(field: string) {
    if (!list) return;
    const current = list.state.sort;
    const next =
      current?.field !== field
        ? { field, direction: 'asc' as const }
        : current.direction === 'asc'
          ? { field, direction: 'desc' as const }
          : null;
    list.change({ sort: next });
  }

  const columnCount = columns.length + (selection ? 1 : 0);
  let body: ReactNode;
  if (error && rows.length === 0) {
    body = (
      <StateRow span={columnCount}>
        <ErrorState error={error} onRetry={onRetry} />
      </StateRow>
    );
  } else if (loading && rows.length === 0) {
    body = (
      <StateRow span={columnCount}>
        <LoadingState />
      </StateRow>
    );
  } else if (rows.length === 0) {
    body = <StateRow span={columnCount}>{empty ?? <EmptyState />}</StateRow>;
  } else {
    body = table.getRowModel().rows.map((row) => {
      const id = row.id;
      const isSelected = selection?.selected.has(id) ?? false;
      const selectable = selection?.isSelectable?.(row.original) ?? true;
      return (
        <tr
          key={id}
          className={isSelected ? styles.selected : undefined}
          aria-selected={selection ? isSelected : undefined}
        >
          {selection ? (
            <td className={styles.checkCell}>
              <input
                type="checkbox"
                checked={isSelected}
                disabled={!selectable}
                onChange={() => toggleRow(id)}
                aria-label={t('table.selectRow')}
              />
            </td>
          ) : null}
          {row.getVisibleCells().map((cell) => (
            <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
          ))}
        </tr>
      );
    });
  }

  return (
    <div>
      <div
        className={`${styles.wrapper} ${fetching ? styles.busy : ''}`}
        aria-busy={fetching || loading}
      >
        <table className={styles.table}>
          <caption className={styles.caption}>{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {selection ? (
                  <th scope="col" className={styles.checkCell}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={selectableRows.length === 0}
                      onChange={toggleAll}
                      aria-label={t('table.selectAll')}
                    />
                  </th>
                ) : null}
                {group.headers.map((header) => {
                  const field = header.column.id;
                  const sortable = list !== undefined && sortableFields.includes(field);
                  const sort = list?.state.sort?.field === field ? list.state.sort.direction : null;
                  const label = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined
                      }
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className={styles.sortButton}
                          onClick={() => cycleSort(field)}
                        >
                          {label}
                          <span aria-hidden="true">
                            {sort === 'asc' ? '▲' : sort === 'desc' ? '▼' : '↕'}
                          </span>
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {list && total !== undefined && total > 0 ? (
        <Pagination
          page={list.state.page}
          pageSize={list.state.pageSize}
          total={total}
          onPageChange={(page) => list.change({ page })}
          onPageSizeChange={(pageSize) => list.change({ pageSize })}
        />
      ) : null}
    </div>
  );
}

function StateRow({ span, children }: Readonly<{ span: number; children: ReactNode }>) {
  return (
    <tr className={styles.stateRow}>
      <td colSpan={span}>{children}</td>
    </tr>
  );
}
