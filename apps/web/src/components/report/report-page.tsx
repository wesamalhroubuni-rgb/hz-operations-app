'use client';

import { WORK_LOG_STATUSES, type WorkLogReport } from '@ops/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { ExportCsvButton } from '@/components/exports/export-button';
import { Button } from '@/components/ui/button';
import { DateRangePicker, FilterBar, SelectFilter } from '@/components/ui/filters';
import { PageHeader } from '@/components/ui/layout';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useDirectory } from '@/hooks/use-directory';
import { useOrganization, useOrgTime } from '@/hooks/use-organization';
import { brand } from '@/lib/brand';
import { formatNumber, t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';
import { applyListChange, hrefWithFilter } from '@/lib/list-params';
import { barPercent, readReportParams } from '@/lib/report';
import {
  dayRangeFilters,
  REPORT_FILTER_KEYS,
  WORK_LOGS_PATH,
  workLogHref,
} from '@/lib/work-logs/filters';

import styles from './report.module.css';

/**
 * `/work-logs/report`: the printable report of a date range (`GET /reports/work-logs`, at most
 * 92 days, the caller's scope). Controls are hidden when printing; the page lays out totals,
 * per-day bars, groupings and the log rows for paper (`@media print` in report.module.css).
 */
export function ReportPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const orgTime = useOrgTime();
  const organization = useOrganization();
  const names = useDirectory();
  const parsed = readReportParams(new URLSearchParams(params.toString()), orgTime);

  const query = useQuery<WorkLogReport>({
    queryKey: queryKeys.reports.workLogs(parsed.ok ? { ...parsed.query } : {}),
    queryFn: async () => {
      if (!parsed.ok) throw new Error(parsed.message);
      return unwrap(await requireApiClient().reports.workLogs(parsed.query));
    },
    enabled: parsed.ok,
  });

  const change = (filters: Record<string, string | null>) => {
    const next = applyListChange(new URLSearchParams(params.toString()), { filters });
    router.replace(next === '' ? pathname : `${pathname}?${next}`, { scroll: false });
  };
  const set = (key: string) => (value: string | null) => change({ [key]: value });
  const report = query.data;
  const filters: Record<string, string> = Object.fromEntries(
    REPORT_FILTER_KEYS.flatMap((key) => {
      const value = params.get(key);
      return value ? [[key, value] as const] : [];
    }),
  );
  const exportFilters = parsed.ok
    ? { ...filters, occurredFrom: parsed.query.occurredFrom, occurredTo: parsed.query.occurredTo }
    : filters;

  return (
    <div className={styles.page}>
      <div className={styles.screenOnly}>
        <p>
          <Link href={hrefWithFilter(WORK_LOGS_PATH, exportFilters)} className={styles.link}>
            {t('report.back')}
          </Link>
        </p>
      </div>
      <PageHeader
        title={t('pages.report.title')}
        description={t('report.description')}
        actions={
          <div className={styles.screenOnly}>
            <div className={styles.actions}>
              <ExportCsvButton kind="workLogs" query={exportFilters} />
              <Button variant="primary" onClick={() => window.print()} disabled={!report}>
                {t('report.print')}
              </Button>
            </div>
          </div>
        }
      />
      <div className={styles.screenOnly}>
        <FilterBar
          activeCount={Object.keys(filters).length}
          onClear={() => change(Object.fromEntries(REPORT_FILTER_KEYS.map((key) => [key, null])))}
        >
          <DateRangePicker
            value={parsed.days}
            today={orgTime.today()}
            onChange={(range) => {
              const next = dayRangeFilters(range, orgTime);
              if (next !== null) change(next);
            }}
          />
          <SelectFilter
            label={t('filters.site')}
            value={filters.siteId}
            options={names.options.sites}
            onChange={set('siteId')}
          />
          <SelectFilter
            label={t('filters.team')}
            value={filters.teamId}
            options={names.options.teams}
            onChange={set('teamId')}
          />
          <SelectFilter
            label={t('filters.worker')}
            value={filters.authorId}
            options={names.options.users}
            onChange={set('authorId')}
          />
          <SelectFilter
            label={t('filters.logType')}
            value={filters.logTypeId}
            options={names.options.logTypes}
            onChange={set('logTypeId')}
          />
          <SelectFilter
            label={t('filters.status')}
            value={filters.status}
            options={WORK_LOG_STATUSES.map((status) => ({
              value: status,
              label: t(`status.workLog.${status}`),
            }))}
            onChange={set('status')}
          />
        </FilterBar>
      </div>

      {!parsed.ok ? (
        <p className={styles.notice} role="alert">
          {parsed.message}
        </p>
      ) : null}
      {query.isLoading ? <LoadingState /> : null}
      {!report && query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}

      {report && parsed.ok ? (
        <article className={styles.report} aria-label={t('pages.report.title')}>
          <header className={styles.reportHeader}>
            <p className={styles.brand}>
              {brand.name} · {organization.data?.name ?? ''}
            </p>
            <p className={styles.range}>
              {t('report.range', {
                from: orgTime.day(parsed.days.from),
                to: orgTime.day(parsed.days.to),
              })}
            </p>
            <p className={styles.meta}>
              {t('report.generatedAt', { when: orgTime.dateTime(report.generatedAt) })}
              {' · '}
              {t('report.timeZone', { timeZone: report.timeZone })}
              {' · '}
              {t('report.scope')}
            </p>
            {Object.keys(filters).length > 0 ? (
              <p className={styles.meta}>
                {t('report.filtersApplied', {
                  filters: describeFilters(filters, names),
                })}
              </p>
            ) : null}
          </header>

          <Section title={t('report.totals.heading')}>
            <dl className={styles.totals}>
              {(
                [
                  'logs',
                  'submitted',
                  'approved',
                  'rejected',
                  'draft',
                  'withPhotos',
                  'withLocation',
                ] as const
              ).map((key) => (
                <div key={key} className={styles.total}>
                  <dt>{t(`report.totals.${key}`)}</dt>
                  <dd>{formatNumber(report.totals[key])}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title={t('report.byDay.heading')}>
            <ByDay report={report} />
          </Section>

          <div className={styles.groups}>
            <GroupTable
              title={t('report.bySite.heading')}
              none={t('report.bySite.none')}
              rows={report.bySite}
            />
            <GroupTable
              title={t('report.byTeam.heading')}
              none={t('report.byTeam.none')}
              rows={report.byTeam}
            />
            <GroupTable
              title={t('report.byLogType.heading')}
              none={t('report.byLogType.none')}
              rows={report.byLogType}
            />
          </div>

          <Section title={t('report.byWorker.heading')}>
            {report.byWorker.length === 0 ? (
              <p className={styles.meta}>{t('report.logs.empty')}</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('report.byWorker.worker')}</th>
                    <th scope="col" className={styles.number}>
                      {t('report.byWorker.count')}
                    </th>
                    <th scope="col" className={styles.number}>
                      {t('report.byWorker.approved')}
                    </th>
                    <th scope="col" className={styles.number}>
                      {t('report.byWorker.rejected')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.byWorker.map((row) => (
                    <tr key={row.authorId}>
                      <th scope="row">{row.displayName ?? t('common.someone')}</th>
                      <td className={styles.number}>{formatNumber(row.count)}</td>
                      <td className={styles.number}>{formatNumber(row.approved)}</td>
                      <td className={styles.number}>{formatNumber(row.rejected)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title={t('report.logs.heading')}>
            <ReportLogs report={report} />
          </Section>
        </article>
      ) : null}
    </div>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

function describeFilters(
  filters: Record<string, string>,
  names: ReturnType<typeof useDirectory>,
): string {
  const parts: string[] = [];
  if (filters.siteId) parts.push(`${t('filters.site')}: ${names.site(filters.siteId)}`);
  if (filters.teamId) parts.push(`${t('filters.team')}: ${names.team(filters.teamId)}`);
  if (filters.authorId) parts.push(`${t('filters.worker')}: ${names.user(filters.authorId)}`);
  if (filters.logTypeId) {
    parts.push(`${t('filters.logType')}: ${names.logType(filters.logTypeId)}`);
  }
  if (filters.status) {
    parts.push(
      `${t('filters.status')}: ${t(`status.workLog.${filters.status}` as TranslationKey)}`,
    );
  }
  return parts.join(' · ');
}

function ByDay({ report }: Readonly<{ report: WorkLogReport }>) {
  const orgTime = useOrgTime();
  const max = Math.max(0, ...report.byDay.map((entry) => entry.count));
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">{t('report.byDay.day')}</th>
          <th scope="col" className={styles.number}>
            {t('report.byDay.count')}
          </th>
          <th scope="col" aria-hidden="true" className={styles.barColumn} />
        </tr>
      </thead>
      <tbody>
        {report.byDay.map((entry) => (
          <tr key={entry.day}>
            <th scope="row">{orgTime.day(entry.day)}</th>
            <td className={styles.number}>{formatNumber(entry.count)}</td>
            <td aria-hidden="true" className={styles.barColumn}>
              <span
                className={styles.bar}
                style={{ inlineSize: `${barPercent(entry.count, max)}%` }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GroupTable({
  title,
  none,
  rows,
}: Readonly<{
  title: string;
  none: string;
  rows: WorkLogReport['bySite'];
}>) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <p className={styles.meta}>{t('report.logs.empty')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('report.group.name')}</th>
              <th scope="col" className={styles.number}>
                {t('report.group.count')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id ?? 'none'}>
                <th scope="row">{row.name ?? none}</th>
                <td className={styles.number}>{formatNumber(row.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ReportLogs({ report }: Readonly<{ report: WorkLogReport }>) {
  const orgTime = useOrgTime();
  if (report.logs.length === 0) {
    return <EmptyState title={t('report.logs.empty')} />;
  }
  return (
    <>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>{t('report.logs.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('report.logs.occurredAt')}</th>
            <th scope="col">{t('report.logs.worker')}</th>
            <th scope="col">{t('report.logs.site')}</th>
            <th scope="col">{t('report.logs.team')}</th>
            <th scope="col">{t('report.logs.logType')}</th>
            <th scope="col">{t('report.logs.status')}</th>
            <th scope="col">{t('report.logs.excerpt')}</th>
            <th scope="col" className={styles.number}>
              {t('report.logs.photos')}
            </th>
          </tr>
        </thead>
        <tbody>
          {report.logs.map((row) => (
            <tr key={row.id}>
              <td className={styles.nowrap}>
                <Link href={workLogHref(row.id)} className={styles.link}>
                  {orgTime.sortable(row.occurredAt)}
                </Link>
              </td>
              <td>{row.authorName ?? t('common.someone')}</td>
              <td>{row.siteName ?? ''}</td>
              <td>{row.teamName ?? ''}</td>
              <td>{row.logTypeName ?? ''}</td>
              <td>{t(`status.workLog.${row.status}`)}</td>
              <td>{row.excerpt ?? ''}</td>
              <td className={styles.number}>{formatNumber(row.attachmentCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.logsTruncated ? (
        <p className={styles.meta}>
          {t('report.logs.truncated', { count: formatNumber(report.logs.length) })}
        </p>
      ) : null}
    </>
  );
}
