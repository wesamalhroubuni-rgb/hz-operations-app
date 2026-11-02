'use client';

import type { AnomalyFlag, DailySummary, Paginated } from '@ops/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo } from 'react';

import { DateRangePicker } from '@/components/ui/filters';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useDirectory } from '@/hooks/use-directory';
import { useListParams } from '@/hooks/use-list-params';
import { useOrgTime } from '@/hooks/use-organization';
import { formatNumber, t } from '@/i18n';
import {
  ANOMALY_PANEL_DEFAULT_DAYS,
  ANOMALY_PANEL_PAGE_SIZE,
  DAY_RANGE_KEYS,
  dayRangeFrom,
  SUMMARY_HISTORY_PATH,
  type ReasonNames,
} from '@/lib/ai';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';

import styles from './ai.module.css';
import { AnomalyTable, SummaryView } from './summary-view';

/** Names for flag reasons: what the caller may see (the directory) and org-local days. */
export function useReasonNames(): ReasonNames {
  const directory = useDirectory();
  const orgTime = useOrgTime();
  return useMemo(
    () => ({
      site: (id) => directory.site(id),
      user: (id) => directory.user(id),
      dayOf: (value) => orgTime.dayOf(value),
    }),
    [directory, orgTime],
  );
}

/**
 * Overview: the caller's latest daily summary (`GET /ai/summaries`, their own only), with the
 * key numbers and its flags, and a link to the history.
 */
export function LatestSummaryPanel() {
  const orgTime = useOrgTime();
  const names = useReasonNames();
  const query = useQuery<Paginated<DailySummary>>({
    queryKey: queryKeys.ai.summaries({ latest: true }),
    queryFn: async () => unwrap(await requireApiClient().aiSummaries.list({ pageSize: 1 })),
    refetchInterval: 5 * 60_000,
  });
  const latest = query.data?.items[0];
  const historyLink = (
    <Link href={SUMMARY_HISTORY_PATH} className={styles.link}>
      {t('ai.summary.history')}
    </Link>
  );
  return (
    <section className={styles.panel} aria-labelledby="latest-summary">
      <div className={styles.panelHead}>
        <h2 id="latest-summary" className={styles.panelTitle}>
          {t('ai.summary.panelTitle')}
        </h2>
        {latest ? historyLink : null}
      </div>
      {query.isLoading ? <LoadingState inline /> : null}
      {!query.data && query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && !latest ? (
        <EmptyState title={t('ai.summary.none')} description={t('ai.summary.noneHint')} />
      ) : null}
      {latest ? (
        <SummaryView
          summary={latest}
          names={names}
          formatDay={orgTime.day}
          formatTime={orgTime.dateTime}
        />
      ) : null}
    </section>
  );
}

/**
 * Overview: the unusual items of a day range (`GET /ai/anomalies`), by default the seven days
 * ending with the overview's day. The range lives in the URL as `from` / `to` (the API's names).
 */
export function AnomalyPanel({ lastDay }: Readonly<{ lastDay: string }>) {
  const orgTime = useOrgTime();
  const names = useReasonNames();
  const list = useListParams(DAY_RANGE_KEYS);
  const range = dayRangeFrom(list.state.filters, lastDay, ANOMALY_PANEL_DEFAULT_DAYS);
  const apiQuery = { ...range, pageSize: ANOMALY_PANEL_PAGE_SIZE };
  const query = useQuery<Paginated<AnomalyFlag>>({
    queryKey: queryKeys.ai.anomalies(apiQuery),
    queryFn: async () => unwrap(await requireApiClient().aiSummaries.anomalies(apiQuery)),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  return (
    <section className={styles.panel} aria-labelledby="anomaly-panel">
      <h2 id="anomaly-panel" className={styles.panelTitle}>
        {t('ai.anomalies.title')}
      </h2>
      <p className={styles.meta}>{t('ai.anomalies.description')}</p>
      <DateRangePicker
        label={t('ai.anomalies.days')}
        value={range}
        today={orgTime.today()}
        onChange={(next) => {
          if (next.from && next.to && next.to < next.from) return;
          list.change({ filters: { from: next.from, to: next.to } });
        }}
      />
      {query.isLoading ? <LoadingState inline /> : null}
      {!data && query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {data ? (
        <>
          <AnomalyTable flags={data.items} names={names} formatDay={orgTime.day} />
          {data.total > data.items.length ? (
            <p className={styles.meta}>
              {t('ai.anomalies.truncated', {
                shown: formatNumber(data.items.length),
                total: formatNumber(data.total),
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
