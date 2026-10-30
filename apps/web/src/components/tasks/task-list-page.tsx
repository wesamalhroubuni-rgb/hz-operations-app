'use client';

import {
  MAX_PAGE_SIZE,
  TASK_FILTER_KEYS,
  TASK_PRIORITIES,
  TASK_SORT_FIELDS,
  TASK_STATUSES,
  type Task,
} from '@ops/shared';
import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { ExportCsvButton } from '@/components/exports/export-button';
import { Notice } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { Checkbox } from '@/components/ui/form-field';
import { PageHeader, Toolbar } from '@/components/ui/layout';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { useCaller } from '@/hooks/use-caller';
import { useDirectory } from '@/hooks/use-directory';
import { useListParams } from '@/hooks/use-list-params';
import { useOrgTime } from '@/hooks/use-organization';
import { t, type TranslationKey } from '@/i18n';
import { activeFilterCount, applyListChange, formatSort } from '@/lib/list-params';
import { groupTasksByStatus, isOverdue, taskActions } from '@/lib/tasks';

import styles from '../manage/manage.module.css';
import { TaskBoard, type TaskCardInfo } from './task-board';
import { TaskFormDialog } from './task-form-dialog';
import { TaskStatusDialog } from './task-status-dialog';
import { useTaskList } from './use-tasks';

const VIEW_PARAM = 'view';

/** `/tasks`: the task list and the board by status, filters in the URL (ADR-0009). */
export function TaskListPage() {
  const caller = useCaller();
  const directory = useDirectory();
  const orgTime = useOrgTime();
  const list = useListParams(TASK_FILTER_KEYS);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = searchParams.get(VIEW_PARAM) === 'board' ? 'board' : 'list';
  const [now] = useState(() => new Date());
  const [creating, setCreating] = useState(false);
  const [statusTaskId, setStatusTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The board shows every status of the filtered set on one page (largest page size).
  const boardQuery = useMemo(() => {
    const { status: _status, ...filters } = list.state.filters;
    const sort = formatSort(list.state.sort);
    return { ...filters, page: 1, pageSize: MAX_PAGE_SIZE, ...(sort ? { sort } : {}) };
  }, [list.state.filters, list.state.sort]);
  const listQuery = useTaskList(list.apiQuery, view === 'list');
  const board = useTaskList(boardQuery, view === 'board');
  const active = view === 'board' ? board : listQuery;
  const tasks = active.data?.items;
  const statusTask = tasks?.find((task) => task.id === statusTaskId) ?? null;

  function setView(next: 'list' | 'board') {
    const query = applyListChange(new URLSearchParams(searchParams.toString()), {
      filters: { [VIEW_PARAM]: next === 'board' ? 'board' : null },
    });
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  }

  const info = (task: Task): TaskCardInfo => ({
    assignees:
      task.assigneeIds.length > 0
        ? task.assigneeIds.map((id) => directory.user(id)).join(', ')
        : t('tasks.unassigned'),
    place: [directory.site(task.siteId), directory.team(task.teamId)].filter(Boolean).join(' · '),
    due: task.dueAt ? orgTime.dateTime(task.dueAt) : t('tasks.noDue'),
    overdue: isOverdue(task, now),
  });

  const columns: ColumnDef<Task>[] = [
    {
      id: 'title',
      header: t('tasks.columns.title'),
      cell: ({ row }) => (
        <div>
          <Link href={`/tasks/${row.original.id}`} className={styles.link}>
            {row.original.title}
          </Link>
          {row.original.status === 'blocked' && row.original.statusReason ? (
            <p className={styles.reason}>
              {t('tasks.blockedReason', { reason: row.original.statusReason })}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      id: 'status',
      header: t('tasks.columns.status'),
      cell: ({ row }) => (
        <div className={styles.row}>
          <StatusBadge kind="task" value={row.original.status} />
          {row.original.archivedAt ? <StatusBadge kind="archived" /> : null}
        </div>
      ),
    },
    {
      id: 'priority',
      header: t('tasks.columns.priority'),
      cell: ({ row }) => <StatusBadge kind="priority" value={row.original.priority} />,
    },
    {
      id: 'assignees',
      header: t('tasks.columns.assignees'),
      cell: ({ row }) => info(row.original).assignees,
    },
    {
      id: 'place',
      header: t('tasks.columns.place'),
      cell: ({ row }) => info(row.original).place || '—',
    },
    {
      id: 'dueAt',
      header: t('tasks.columns.dueAt'),
      cell: ({ row }) => {
        const card = info(row.original);
        return (
          <div className={styles.row}>
            <span>{card.due}</span>
            {card.overdue ? <Badge tone="danger" label={t('tasks.overdue')} /> : null}
          </div>
        );
      },
    },
    {
      id: 'updatedAt',
      header: t('tasks.columns.updatedAt'),
      cell: ({ row }) => orgTime.dateTime(row.original.updatedAt),
    },
    {
      id: 'actions',
      header: t('tasks.columns.actions'),
      cell: ({ row }) =>
        taskActions(caller.capabilities, row.original).changeStatus ? (
          <Button
            size="sm"
            onClick={() => setStatusTaskId(row.original.id)}
            aria-label={t('tasks.board.moveLabel', { title: row.original.title })}
          >
            {t('tasks.status.change')}
          </Button>
        ) : null,
    },
  ];

  const filters = list.state.filters;
  const setFilter = (key: string) => (value: string | null) =>
    list.change({ filters: { [key]: value } });
  const sort = formatSort(list.state.sort);
  const exportQuery = { ...filters, ...(sort ? { sort } : {}) };
  const filterCount = activeFilterCount(list.state);

  return (
    <>
      <PageHeader
        title={t('pages.tasks.title')}
        description={t('tasks.description')}
        actions={
          caller.capabilities.manageTasks ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('tasks.create')}
            </Button>
          ) : null
        }
      />
      <FilterBar activeCount={filterCount} onClear={list.clearFilters}>
        <SearchFilter value={filters.search} onChange={setFilter('search')} />
        {view === 'list' ? (
          <SelectFilter
            label={t('filters.status')}
            value={filters.status}
            options={TASK_STATUSES.map((value) => ({
              value,
              label: t(`status.task.${value}` as TranslationKey),
            }))}
            onChange={setFilter('status')}
          />
        ) : null}
        <SelectFilter
          label={t('filters.priority')}
          value={filters.priority}
          options={TASK_PRIORITIES.map((value) => ({
            value,
            label: t(`priority.${value}` as TranslationKey),
          }))}
          onChange={setFilter('priority')}
        />
        <SelectFilter
          label={t('filters.assignee')}
          value={filters.assigneeId}
          options={directory.options.users}
          onChange={setFilter('assigneeId')}
        />
        <SelectFilter
          label={t('filters.site')}
          value={filters.siteId}
          options={directory.options.sites}
          onChange={setFilter('siteId')}
        />
        <SelectFilter
          label={t('filters.team')}
          value={filters.teamId}
          options={directory.options.teams}
          onChange={setFilter('teamId')}
        />
        <div className={styles.formStack}>
          <Checkbox
            label={t('tasks.openOnly')}
            checked={filters.open === 'true'}
            onChange={(event) => setFilter('open')(event.target.checked ? 'true' : null)}
          />
          <Checkbox
            label={t('tasks.overdueOnly')}
            checked={filters.overdue === 'true'}
            onChange={(event) => setFilter('overdue')(event.target.checked ? 'true' : null)}
          />
          <Checkbox
            label={t('filters.includeArchived')}
            checked={filters.includeArchived === 'true'}
            onChange={(event) => setFilter('includeArchived')(event.target.checked ? 'true' : null)}
          />
        </div>
      </FilterBar>

      <Toolbar
        start={
          <div className={styles.segmented} role="group" aria-label={t('tasks.viewLabel')}>
            <button
              type="button"
              className={styles.segment}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              {t('tasks.viewList')}
            </button>
            <button
              type="button"
              className={styles.segment}
              aria-pressed={view === 'board'}
              onClick={() => setView('board')}
            >
              {t('tasks.viewBoard')}
            </button>
          </div>
        }
        end={
          caller.capabilities.exportData ? (
            <ExportCsvButton kind="tasks" query={exportQuery} />
          ) : null
        }
      />
      <Notice>{notice}</Notice>

      {view === 'list' ? (
        <DataTable
          columns={columns}
          data={listQuery.data?.items}
          getRowId={(task) => task.id}
          caption={t('tasks.caption')}
          list={list}
          total={listQuery.data?.total}
          sortableFields={TASK_SORT_FIELDS}
          loading={listQuery.isLoading}
          fetching={listQuery.isFetching}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          empty={
            <EmptyState title={filterCount > 0 ? t('states.emptyFiltered') : t('tasks.empty')} />
          }
        />
      ) : board.isLoading ? (
        <LoadingState />
      ) : board.error && !board.data ? (
        <ErrorState error={board.error} onRetry={() => void board.refetch()} />
      ) : (
        <>
          {board.data && board.data.total > board.data.items.length ? (
            <p className={styles.muted}>
              {t('tasks.board.partial', {
                shown: board.data.items.length,
                total: board.data.total,
              })}
            </p>
          ) : null}
          <TaskBoard
            groups={groupTasksByStatus(board.data?.items ?? [])}
            info={info}
            canChangeStatus={(task) => taskActions(caller.capabilities, task).changeStatus}
            onChangeStatus={(task) => setStatusTaskId(task.id)}
          />
        </>
      )}

      {creating ? (
        <TaskFormDialog
          task={null}
          mode="create"
          onClose={() => setCreating(false)}
          onDone={(_task, message) => setNotice(message)}
        />
      ) : null}
      {statusTask ? (
        <TaskStatusDialog
          task={statusTask}
          onClose={() => setStatusTaskId(null)}
          onDone={setNotice}
        />
      ) : null}
    </>
  );
}
