'use client';

import type { AiUsageReport } from '@ops/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { DateRangePicker } from '@/components/ui/filters';
import { PageHeader } from '@/components/ui/layout';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useListParams } from '@/hooks/use-list-params';
import { useOrgTime } from '@/hooks/use-organization';
import { formatNumber, t, type TranslationKey } from '@/i18n';
import { DAY_RANGE_KEYS, formatUsd, isDayKey } from '@/lib/ai';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';

import styles from './ai.module.css';

const KNOWN_FEATURES = ['capture_transcription', 'capture_extraction', 'summary_narrative'];

function featureLabel(feature: string): string {
  return KNOWN_FEATURES.includes(feature)
    ? t(`ai.usage.features.${feature}` as TranslationKey)
    : feature;
}

/** The report's parts as plain markup (props only, so it renders in tests). */
export function AiUsageReportView({
  report,
  formatTime,
}: Readonly<{ report: AiUsageReport; formatTime: (value: string) => string }>) {
  const { today, limits, providers, totals, rows } = report;
  const provider = (info: { name: string; model: string }) =>
    info.name === 'fake' ? t('ai.usage.fakeProvider') : `${info.name} · ${info.model}`;
  return (
    <>
      <div className={styles.numbers}>
        <section className={styles.panel} aria-labelledby="usage-today">
          <h2 id="usage-today" className={styles.panelTitle}>
            {t('ai.usage.today')} · {today.day}
          </h2>
          <p>
            {t('ai.usage.requestsToday', {
              used: formatNumber(today.requests),
              limit: formatNumber(limits.dailyRequestLimit),
            })}
          </p>
          <p>
            {t('ai.usage.costToday', {
              used: formatUsd(today.costUsd),
              limit: formatUsd(limits.dailyCostLimitUsd),
            })}
          </p>
          <p className={styles.meta}>
            {t('ai.usage.rateLimit', { count: limits.rateLimitPerUserPerMinute })}
          </p>
        </section>
        <section className={styles.panel} aria-labelledby="usage-providers">
          <h2 id="usage-providers" className={styles.panelTitle}>
            {t('ai.usage.providers')}
          </h2>
          <p>
            {t('ai.usage.llm')}: {provider(providers.llm)}
          </p>
          <p>
            {t('ai.usage.speechToText')}: {provider(providers.speechToText)}
          </p>
          <p className={styles.meta}>
            {t('ai.usage.updatedAt', { time: formatTime(report.generatedAt) })}
          </p>
        </section>
        <section className={styles.panel} aria-labelledby="usage-totals">
          <h2 id="usage-totals" className={styles.panelTitle}>
            {t('ai.usage.totals')}
          </h2>
          <p>
            {t('ai.usage.columns.requests')}: {formatNumber(totals.requests)}
          </p>
          <p>
            {t('ai.usage.columns.tokens')}: {formatNumber(totals.inputTokens)} /{' '}
            {formatNumber(totals.outputTokens)}
          </p>
          <p>
            {t('ai.usage.columns.cost')}: {formatUsd(totals.costUsd)}
          </p>
        </section>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t('ai.usage.empty')} />
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <caption className={styles.visuallyHidden}>{t('ai.usage.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('ai.usage.columns.day')}</th>
                <th scope="col">{t('ai.usage.columns.feature')}</th>
                <th scope="col">{t('ai.usage.columns.model')}</th>
                <th scope="col" className={styles.end}>
                  {t('ai.usage.columns.requests')}
                </th>
                <th scope="col" className={styles.end}>
                  {t('ai.usage.columns.ok')}
                </th>
                <th scope="col" className={styles.end}>
                  {t('ai.usage.columns.problems')}
                </th>
                <th scope="col" className={styles.end}>
                  {t('ai.usage.columns.limited')}
                </th>
                <th scope="col" className={styles.end}>
                  {t('ai.usage.columns.tokens')}
                </th>
                <th scope="col" className={styles.end}>
                  {t('ai.usage.columns.audio')}
                </th>
                <th scope="col" className={styles.end}>
                  {t('ai.usage.columns.cost')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.day}|${row.feature}|${row.provider}|${row.model}`}>
                  <td>{row.day}</td>
                  <th scope="row">{featureLabel(row.feature)}</th>
                  <td>
                    {row.provider} · {row.model}
                  </td>
                  <td className={styles.end}>{formatNumber(row.requests)}</td>
                  <td className={styles.end}>{formatNumber(row.ok)}</td>
                  <td className={styles.end}>
                    {formatNumber(row.invalidOutput + row.failed + row.timeout)}
                  </td>
                  <td className={styles.end}>{formatNumber(row.limited)}</td>
                  <td className={styles.end}>
                    {formatNumber(row.inputTokens)} / {formatNumber(row.outputTokens)}
                  </td>
                  <td className={styles.end}>{formatNumber(row.audioSeconds, 0)}</td>
                  <td className={styles.end}>{formatUsd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** `/ai-usage` (admins): `GET /ai/usage` for a range of UTC days (the unit of the limits). */
export function AiUsagePage() {
  const orgTime = useOrgTime();
  const list = useListParams(DAY_RANGE_KEYS);
  const { filters } = list.state;
  const from = isDayKey(filters.from) ? filters.from : null;
  const to = isDayKey(filters.to) ? filters.to : null;
  const apiQuery = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const query = useQuery<AiUsageReport>({
    queryKey: queryKeys.ai.usage(apiQuery),
    queryFn: async () => unwrap(await requireApiClient().aiUsage.get(apiQuery)),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  // Usage days are UTC days (the limits count per UTC day).
  const utcToday = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHeader title={t('ai.pages.usage')} description={t('ai.usage.description')} />
      <DateRangePicker
        label={t('ai.usage.days')}
        value={{ from, to }}
        today={utcToday}
        onChange={(next) => {
          if (next.from && next.to && next.to < next.from) return;
          list.change({ filters: { from: next.from, to: next.to } });
        }}
      />
      {query.isLoading ? <LoadingState /> : null}
      {!query.data && query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data ? <AiUsageReportView report={query.data} formatTime={orgTime.dateTime} /> : null}
    </>
  );
}
