'use client';

import type { AuditEvent, Paginated } from '@ops/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';

import { DetailList } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Drawer } from '@/components/ui/dialog';
import { DateRangePicker, FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { PageHeader } from '@/components/ui/layout';
import { EmptyState } from '@/components/ui/states';
import { Badge } from '@/components/ui/status-badge';
import { useDirectory } from '@/hooks/use-directory';
import { useListParams } from '@/hooks/use-list-params';
import { useOrgTime } from '@/hooks/use-organization';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_FILTER_KEYS,
  auditDiffRows,
  offlineSyncOf,
  prettyJson,
  shortId,
} from '@/lib/audit';
import { activeFilterCount } from '@/lib/list-params';
import { daysOfRange } from '@/lib/time';

import styles from '../manage/manage.module.css';

function entityTypeLabel(type: string): string {
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(type)
    ? t(`audit.entityTypes.${type}` as TranslationKey)
    : type;
}

/** One event in full (props only, so it renders in tests). Redacted values stay hidden. */
export function AuditEventDetail({
  event,
  actorName,
  formatTime,
}: Readonly<{ event: AuditEvent; actorName: string; formatTime: (value: string) => string }>) {
  const none = t('audit.detail.none');
  const rows = auditDiffRows(event, none);
  const offline = offlineSyncOf(event);
  const before = prettyJson(event.before);
  const after = prettyJson(event.after);
  return (
    <div className={styles.stack}>
      <DetailList
        items={[
          {
            label: t('audit.detail.action'),
            value: <span className={styles.mono}>{event.action}</span>,
          },
          { label: t('audit.detail.occurredAt'), value: formatTime(event.occurredAt) },
          { label: t('audit.detail.actor'), value: actorName },
          {
            label: t('audit.detail.entity'),
            value: (
              <>
                {entityTypeLabel(event.entityType)} ·{' '}
                <span className={styles.mono}>{event.entityId}</span>
              </>
            ),
          },
          {
            label: t('audit.detail.correlationId'),
            value: <span className={styles.mono}>{event.correlationId ?? none}</span>,
          },
        ]}
      />
      <section aria-labelledby="audit-changes">
        <h3 id="audit-changes" className={styles.cardTitle}>
          {t('audit.detail.changes')}
        </h3>
        {rows.length === 0 ? (
          <p className={styles.muted}>{t('audit.detail.noChanges')}</p>
        ) : (
          <>
            <table className={styles.diff}>
              <thead>
                <tr>
                  <th scope="col">{t('audit.detail.field')}</th>
                  <th scope="col">{t('audit.detail.from')}</th>
                  <th scope="col">{t('audit.detail.to')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.field}>
                    <th scope="row" className={styles.mono}>
                      {row.field}
                      {row.redacted ? (
                        <>
                          {' '}
                          <Badge tone="muted" label={t('audit.detail.redacted')} />
                        </>
                      ) : null}
                    </th>
                    <td className={styles.mono}>{row.from}</td>
                    <td className={styles.mono}>{row.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.some((row) => row.redacted) ? (
              <p className={styles.muted}>{t('audit.detail.redactedNote')}</p>
            ) : null}
          </>
        )}
      </section>
      {offline ? (
        <section aria-labelledby="audit-offline" className={styles.card}>
          <h3 id="audit-offline" className={styles.cardTitle}>
            {t('audit.detail.offlineTitle')}
          </h3>
          <DetailList
            items={[
              {
                label: t('audit.detail.deviceTime'),
                value: offline.deviceTime ? formatTime(offline.deviceTime) : none,
              },
              { label: t('audit.detail.serverTime'), value: formatTime(offline.serverTime) },
              {
                label: t('audit.detail.clockSkew'),
                value:
                  offline.clockSkewSeconds === null
                    ? none
                    : t('audit.detail.clockSkewValue', { seconds: offline.clockSkewSeconds }),
              },
              ...(offline.droppedReferences && offline.droppedReferences.length > 0
                ? [
                    {
                      label: t('audit.detail.droppedReferences'),
                      value: offline.droppedReferences.join(', '),
                    },
                  ]
                : []),
            ]}
          />
        </section>
      ) : null}
      {before ? (
        <details>
          <summary className={styles.summary}>{t('audit.detail.before')}</summary>
          <pre className={styles.json}>{before}</pre>
        </details>
      ) : null}
      {after ? (
        <details>
          <summary className={styles.summary}>{t('audit.detail.after')}</summary>
          <pre className={styles.json}>{after}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** `/audit` (admins only): searchable, filtered, paginated audit events with a detail drawer. */
export function AuditPage() {
  const directory = useDirectory();
  const orgTime = useOrgTime();
  const list = useListParams(AUDIT_FILTER_KEYS);
  const query = list.apiQuery;
  const events = useQuery<Paginated<AuditEvent>>({
    queryKey: queryKeys.audit.list(query),
    queryFn: async () => unwrap(await requireApiClient().auditEvents.list(query)),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState<AuditEvent | null>(null);
  const filters = list.state.filters;
  const setFilter = (key: string) => (value: string | null) =>
    list.change({ filters: { [key]: value } });
  const days = daysOfRange({ from: filters.from, to: filters.to }, orgTime.timeZone);
  const actorName = (event: AuditEvent) =>
    event.actorType === 'system'
      ? t('audit.system')
      : directory.user(event.actorId) || t('common.unknown');

  const columns: ColumnDef<AuditEvent>[] = [
    {
      id: 'occurredAt',
      header: t('audit.columns.occurredAt'),
      cell: ({ row }) => orgTime.dateTime(row.original.occurredAt),
    },
    { id: 'actor', header: t('audit.columns.actor'), cell: ({ row }) => actorName(row.original) },
    {
      id: 'action',
      header: t('audit.columns.action'),
      cell: ({ row }) => <span className={styles.mono}>{row.original.action}</span>,
    },
    {
      id: 'entity',
      header: t('audit.columns.entity'),
      cell: ({ row }) => (
        <span>
          {entityTypeLabel(row.original.entityType)}{' '}
          <span className={styles.mono} title={row.original.entityId}>
            {shortId(row.original.entityId)}
          </span>
        </span>
      ),
    },
    {
      id: 'via',
      header: t('audit.columns.via'),
      cell: ({ row }) =>
        offlineSyncOf(row.original) ? (
          <Badge tone="info" label={t('audit.offline')} />
        ) : (
          t('audit.online')
        ),
    },
    {
      id: 'details',
      header: t('audit.columns.details'),
      cell: ({ row }) => (
        <Button
          size="sm"
          onClick={() => setOpen(row.original)}
          aria-label={t('audit.viewLabel', { action: row.original.action })}
        >
          {t('audit.view')}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t('pages.audit.title')} description={t('audit.description')} />
      <FilterBar activeCount={activeFilterCount(list.state)} onClear={list.clearFilters}>
        <SelectFilter
          label={t('audit.filters.actor')}
          value={filters.actorId}
          options={directory.options.users}
          onChange={setFilter('actorId')}
        />
        <SelectFilter
          label={t('audit.filters.entityType')}
          value={filters.entityType}
          options={AUDIT_ENTITY_TYPES.map((value) => ({ value, label: entityTypeLabel(value) }))}
          onChange={setFilter('entityType')}
        />
        <SearchFilter
          label={t('audit.filters.action')}
          value={filters.action}
          onChange={setFilter('action')}
        />
        <SearchFilter
          label={t('audit.filters.entityId')}
          value={filters.entityId}
          onChange={setFilter('entityId')}
        />
        <SearchFilter
          label={t('audit.filters.correlationId')}
          value={filters.correlationId}
          onChange={setFilter('correlationId')}
        />
        <DateRangePicker
          label={t('audit.filters.date')}
          value={days}
          today={orgTime.today()}
          onChange={(range) => {
            if (range.from === null && range.to === null) {
              list.change({ filters: { from: null, to: null } });
              return;
            }
            const first = range.from ?? range.to ?? orgTime.today();
            const last = range.to ?? orgTime.today();
            if (last < first) return;
            const instants = orgTime.range(first, last);
            list.change({ filters: { from: instants.from, to: instants.to } });
          }}
        />
      </FilterBar>
      <p className={styles.muted}>{t('audit.filters.actionHint')}</p>
      <DataTable
        columns={columns}
        data={events.data?.items}
        getRowId={(event) => event.id}
        caption={t('audit.caption')}
        list={list}
        total={events.data?.total}
        sortableFields={['occurredAt']}
        loading={events.isLoading}
        fetching={events.isFetching}
        error={events.error}
        onRetry={() => void events.refetch()}
        empty={<EmptyState title={t('audit.empty')} />}
      />
      {open ? (
        <Drawer open onClose={() => setOpen(null)} title={t('audit.detail.title')}>
          <AuditEventDetail
            event={open}
            actorName={actorName(open)}
            formatTime={orgTime.dateTime}
          />
        </Drawer>
      ) : null}
    </>
  );
}
