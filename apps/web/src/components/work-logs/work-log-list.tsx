'use client';

import type { BulkWorkLogStatusResult, WorkLog } from '@ops/shared';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ExportCsvButton } from '@/components/exports/export-button';
import { Button, ButtonLink } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Modal } from '@/components/ui/dialog';
import { PageHeader, Toolbar } from '@/components/ui/layout';
import { EmptyState } from '@/components/ui/states';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { useCaller } from '@/hooks/use-caller';
import { useDirectory } from '@/hooks/use-directory';
import { useListParams } from '@/hooks/use-list-params';
import { useOrgTime } from '@/hooks/use-organization';
import { useBulkReview, useWorkLogList } from '@/hooks/use-work-logs';
import { formatNumber, t } from '@/i18n';
import { describeError } from '@/lib/api/errors';
import { activeFilterCount } from '@/lib/list-params';
import {
  exportQueryOf,
  mapHrefOf,
  reportHrefOf,
  WORK_LOG_LIST_FILTER_KEYS,
  WORK_LOG_SORTABLE,
  workLogHref,
} from '@/lib/work-logs/filters';
import { excerptOf } from '@/lib/work-logs/format';
import {
  bulkItemsOf,
  bulkOutcomeRows,
  isBulkSelectable,
  pruneSelection,
  workLogListFeatures,
} from '@/lib/work-logs/review';

import { ReviewDialog, type ReviewDecision } from './review-dialog';
import { WorkLogFilters } from './work-log-filters';
import styles from './work-logs.module.css';

const column = createColumnHelper<WorkLog>();

/**
 * `/work-logs`: the URL-synced table (filters, sort, page), row selection and bulk approve /
 * reject for reviewers (never the caller's own logs), CSV export of the current filters, and
 * links to the map and the printable report with the same filters.
 */
export function WorkLogListPage() {
  const caller = useCaller();
  const features = workLogListFeatures(caller.capabilities);
  const list = useListParams(WORK_LOG_LIST_FILTER_KEYS);
  const orgTime = useOrgTime();
  const names = useDirectory();
  const query = useWorkLogList(list.apiQuery);
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);

  // The selection belongs to one page of one query: changing filters, sort or page drops it.
  const queryId = JSON.stringify(list.apiQuery);
  const [selection, setSelection] = useState<{ queryId: string; ids: Set<string> }>({
    queryId,
    ids: new Set(),
  });
  const selected = useMemo(
    () =>
      selection.queryId === queryId
        ? pruneSelection(selection.ids, rows, caller.capabilities, caller.user.id)
        : new Set<string>(),
    [selection, queryId, rows, caller.capabilities, caller.user.id],
  );
  const setSelected = (ids: Set<string>) => setSelection({ queryId, ids });

  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [results, setResults] = useState<BulkWorkLogStatusResult | null>(null);
  const bulk = useBulkReview();
  const items = bulkItemsOf(rows, selected, caller.capabilities, caller.user.id);

  const columns = useMemo(
    () => [
      column.accessor('occurredAt', {
        header: () => t('workLogs.table.occurredAt'),
        cell: (info) => {
          const when = orgTime.dateTime(info.getValue());
          return (
            <Link
              href={workLogHref(info.row.original.id)}
              className={styles.link}
              aria-label={t('workLogs.table.openLog', { when })}
            >
              {when}
            </Link>
          );
        },
      }),
      column.display({
        id: 'author',
        header: () => t('workLogs.table.worker'),
        cell: (info) => names.user(info.row.original.authorId),
      }),
      column.display({
        id: 'site',
        header: () => t('workLogs.table.site'),
        cell: (info) => names.site(info.row.original.siteId),
      }),
      column.display({
        id: 'team',
        header: () => t('workLogs.table.team'),
        cell: (info) => names.team(info.row.original.teamId),
      }),
      column.display({
        id: 'logType',
        header: () => t('workLogs.table.logType'),
        cell: (info) => names.logType(info.row.original.logTypeId),
      }),
      column.display({
        id: 'text',
        header: () => t('workLogs.table.text'),
        cell: (info) => {
          const excerpt = excerptOf(info.row.original.text);
          return (
            <span className={styles.excerpt} title={excerpt ?? undefined}>
              {excerpt ?? <span className={styles.muted}>{t('workLogs.table.noText')}</span>}
            </span>
          );
        },
      }),
      column.display({
        id: 'photos',
        header: () => t('workLogs.table.photos'),
        cell: (info) => {
          const count = info.row.original.attachmentCount ?? 0;
          return count > 0 ? t('workLogs.table.photoCount', { count }) : '';
        },
      }),
      column.accessor('status', {
        header: () => t('workLogs.table.status'),
        cell: (info) => (
          <span className={styles.badges}>
            <StatusBadge kind="workLog" value={info.getValue()} />
            {info.row.original.archivedAt ? <StatusBadge kind="archived" /> : null}
            {info.row.original.submittedOffline ? (
              <Badge tone="info" label={t('workLogs.table.offline')} />
            ) : null}
          </span>
        ),
      }),
      column.accessor('createdAt', {
        header: () => t('workLogs.table.createdAt'),
        cell: (info) => orgTime.dateTime(info.getValue()),
      }),
    ],
    [names, orgTime],
  );

  async function submitBulk(note: string | undefined) {
    if (decision === null || items.length === 0) return;
    try {
      const result = await bulk.mutateAsync({ status: decision, note, items });
      setDecision(null);
      setResults(result);
      setSelected(new Set());
    } catch {
      // Shown in the dialog through `bulk.error`.
    }
  }

  const filtered = activeFilterCount(list.state) > 0;

  return (
    <div className={styles.stack}>
      <PageHeader
        title={t('pages.workLogs.title')}
        description={t('workLogs.description')}
        actions={
          <>
            {features.map ? (
              <ButtonLink href={mapHrefOf(list.state.filters)}>{t('nav.map')}</ButtonLink>
            ) : null}
            {features.report ? (
              <ButtonLink href={reportHrefOf(list.state.filters)}>
                {t('workLogs.reportLink')}
              </ButtonLink>
            ) : null}
            {features.exportCsv ? (
              <ExportCsvButton kind="workLogs" query={exportQueryOf(list.state)} />
            ) : null}
          </>
        }
      />
      <WorkLogFilters list={list} names={names} orgTime={orgTime} />
      {features.bulkReview ? (
        <Toolbar
          label={t('workLogs.bulk.toolbar')}
          start={
            selected.size > 0 ? (
              <div className={styles.selectionBar}>
                <span aria-live="polite">{t('table.selected', { count: selected.size })}</span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    bulk.reset();
                    setDecision('approved');
                  }}
                >
                  {t('workLogs.bulk.approve')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    bulk.reset();
                    setDecision('rejected');
                  }}
                >
                  {t('workLogs.bulk.reject')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  {t('workLogs.selection.clear')}
                </Button>
              </div>
            ) : (
              <p className={styles.hint}>{t('workLogs.selection.hint')}</p>
            )
          }
        />
      ) : null}
      <DataTable
        columns={columns}
        data={query.data?.items}
        getRowId={(row) => row.id}
        caption={t('workLogs.table.caption')}
        list={list}
        total={query.data?.total}
        sortableFields={WORK_LOG_SORTABLE}
        loading={query.isLoading}
        fetching={query.isFetching && !query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={
          filtered ? (
            <EmptyState
              title={t('workLogs.empty.title')}
              description={t('states.emptyFiltered')}
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  {t('filters.clearAll')}
                </Button>
              }
            />
          ) : (
            <EmptyState title={t('workLogs.empty.title')} description={t('workLogs.empty.body')} />
          )
        }
        selection={
          features.bulkReview
            ? {
                selected,
                onChange: setSelected,
                isSelectable: (row) => isBulkSelectable(caller.capabilities, caller.user.id, row),
              }
            : undefined
        }
      />
      <ReviewDialog
        decision={decision}
        title={
          decision === 'rejected'
            ? t('workLogs.bulk.rejectTitle', { count: items.length })
            : t('workLogs.bulk.approveTitle', { count: items.length })
        }
        description={
          decision === 'rejected'
            ? t('workLogs.bulk.rejectDescription')
            : t('workLogs.bulk.approveDescription')
        }
        busy={bulk.isPending}
        error={
          bulk.error ? `${t('workLogs.bulk.requestFailed')} ${describeError(bulk.error)}` : null
        }
        onConfirm={(note) => void submitBulk(note)}
        onCancel={() => setDecision(null)}
      />
      <BulkResults result={results} onClose={() => setResults(null)} />
    </div>
  );
}

function BulkResults({
  result,
  onClose,
}: Readonly<{ result: BulkWorkLogStatusResult | null; onClose: () => void }>) {
  const orgRows = result ? bulkOutcomeRows(result) : [];
  return (
    <Modal
      open={result !== null}
      onClose={onClose}
      title={t('workLogs.bulk.resultsTitle')}
      footer={
        <Button variant="primary" onClick={onClose} autoFocus>
          {t('common.close')}
        </Button>
      }
    >
      {result ? (
        <div className={styles.stack}>
          <p
            className={`${styles.notice} ${result.failed > 0 ? styles.noticeWarning : styles.noticeSuccess}`}
            role="status"
          >
            {t('workLogs.bulk.summary', {
              succeeded: formatNumber(result.succeeded),
              failed: formatNumber(result.failed),
            })}
          </p>
          <ul className={styles.results}>
            {orgRows.map((row) => (
              <li key={row.id} className={styles.resultRow}>
                <Badge
                  tone={row.ok ? 'success' : 'danger'}
                  label={row.ok ? t('workLogs.bulk.done') : t('workLogs.bulk.refused')}
                />
                {row.reason ? <span>{row.reason}</span> : null}
                <Link href={workLogHref(row.id)} className={styles.link}>
                  {t('workLogs.bulk.openLog')}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Modal>
  );
}
