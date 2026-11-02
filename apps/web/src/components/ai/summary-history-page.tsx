'use client';

import type { DailySummary, Paginated } from '@ops/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { DateRangePicker } from '@/components/ui/filters';
import { PageHeader } from '@/components/ui/layout';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useListParams } from '@/hooks/use-list-params';
import { useOrgTime } from '@/hooks/use-organization';
import { t } from '@/i18n';
import { DAY_RANGE_KEYS, isDayKey } from '@/lib/ai';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';

import styles from './ai.module.css';
import { useReasonNames } from './summary-panels';
import { SummaryView } from './summary-view';

const PAGE_SIZE = 10;

/**
 * `/summaries` (supervisor and above): the caller's own daily summaries, newest first, with a day
 * range and paging in the URL (`from`, `to`, `page`, `pageSize`: the API's names).
 */
export function SummaryHistoryPage() {
  const orgTime = useOrgTime();
  const names = useReasonNames();
  const list = useListParams(DAY_RANGE_KEYS, PAGE_SIZE);
  const { filters } = list.state;
  const from = isDayKey(filters.from) ? filters.from : null;
  const to = isDayKey(filters.to) ? filters.to : null;
  const apiQuery = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    page: list.state.page,
    pageSize: list.state.pageSize,
  };
  const query = useQuery<Paginated<DailySummary>>({
    queryKey: queryKeys.ai.summaries(apiQuery),
    queryFn: async () => unwrap(await requireApiClient().aiSummaries.list(apiQuery)),
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  return (
    <>
      <PageHeader title={t('ai.pages.summaries')} description={t('ai.history.description')} />
      <DateRangePicker
        label={t('ai.history.days')}
        value={{ from, to }}
        today={orgTime.today()}
        onChange={(next) => {
          if (next.from && next.to && next.to < next.from) return;
          list.change({ filters: { from: next.from, to: next.to } });
        }}
      />
      {query.isLoading ? <LoadingState /> : null}
      {!data && query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {data && data.items.length === 0 ? <EmptyState title={t('ai.history.empty')} /> : null}
      {data && data.items.length > 0 ? (
        <>
          <ul className={styles.list}>
            {data.items.map((summary) => (
              <li key={summary.id}>
                <SummaryView
                  summary={summary}
                  names={names}
                  formatDay={orgTime.day}
                  formatTime={orgTime.dateTime}
                  headingLevel={2}
                />
              </li>
            ))}
          </ul>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={(page) => list.change({ page })}
            onPageSizeChange={(pageSize) => list.change({ pageSize })}
          />
        </>
      ) : null}
    </>
  );
}
