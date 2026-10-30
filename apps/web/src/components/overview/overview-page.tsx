'use client';

import type { DashboardOverview } from '@ops/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/form-field';
import { PageHeader } from '@/components/ui/layout';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useOrgTime } from '@/hooks/use-organization';
import { formatNumber, t } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';
import { hrefWithFilter } from '@/lib/list-params';
import { overviewCards, placeRows, WORK_LOGS_LIST_PATH, type PlaceRow } from '@/lib/overview';

import styles from './overview.module.css';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `/`: the caller's scope at a glance (`GET /dashboard/overview`). Every number is a link to the
 * list it counts, built from the API's `filter`. "Today" is today in the organization's time
 * zone; `?day=YYYY-MM-DD` looks at another day. Refreshes every minute while open.
 */
export function OverviewPage() {
  const orgTime = useOrgTime();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requested = params.get('day');
  const day = requested && DAY_PATTERN.test(requested) ? requested : null;

  const query = useQuery<DashboardOverview>({
    queryKey: queryKeys.dashboard.overview(day),
    queryFn: async () => unwrap(await requireApiClient().dashboard.overview(day ? { day } : {})),
    refetchInterval: 60_000,
  });
  const data = query.data;

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('pages.overview.title')}
        description={t('overview.description')}
        actions={
          <div className={styles.headerActions}>
            <FormField label={t('overview.dayLabel')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={day ?? orgTime.today()}
                  max={orgTime.today()}
                  onChange={(event) => {
                    const next = event.target.value;
                    const search = next && next !== orgTime.today() ? `?day=${next}` : '';
                    router.replace(`${pathname}${search}`, { scroll: false });
                  }}
                />
              )}
            </FormField>
            <Button onClick={() => void query.refetch()} busy={query.isFetching}>
              {t('overview.refresh')}
            </Button>
          </div>
        }
      />
      {query.isLoading ? <LoadingState /> : null}
      {!data && query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {data ? <OverviewContent data={data} /> : null}
    </div>
  );
}

function OverviewContent({ data }: Readonly<{ data: DashboardOverview }>) {
  const orgTime = useOrgTime();
  const cards = overviewCards(data);
  return (
    <>
      <p className={styles.meta}>
        {t('overview.forDay', { day: orgTime.day(data.day) })}
        {' · '}
        {t('overview.updatedAt', { time: orgTime.time(data.generatedAt) })}
      </p>
      <section aria-label={t('overview.numbersLabel')}>
        <ul className={styles.cards}>
          {cards.map((card) => (
            <li key={card.key}>
              <Link
                href={card.href}
                className={`${styles.card} ${card.attention ? styles.attention : ''}`}
                aria-label={t('overview.openList', {
                  label: card.label,
                  count: formatNumber(card.count),
                })}
              >
                <span className={styles.cardCount}>{formatNumber(card.count)}</span>
                <span className={styles.cardLabel}>{card.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <div className={styles.grid}>
        <PlaceTable
          title={t('overview.activity.bySite')}
          rows={placeRows(data.bySite, t('overview.activity.noSite'))}
        />
        <PlaceTable
          title={t('overview.activity.byTeam')}
          rows={placeRows(data.byTeam, t('overview.activity.noTeam'))}
        />
      </div>
      <IdleWorkers data={data} />
    </>
  );
}

function PlaceTable({ title, rows }: Readonly<{ title: string; rows: PlaceRow[] }>) {
  return (
    <section className={styles.panel} aria-label={title}>
      <h2 className={styles.panelTitle}>{title}</h2>
      {rows.length === 0 ? (
        <EmptyState title={t('overview.activity.empty')} />
      ) : (
        <table className={styles.table}>
          <caption className={styles.visuallyHidden}>{title}</caption>
          <thead>
            <tr>
              <th scope="col">{t('overview.activity.name')}</th>
              <th scope="col" className={styles.number}>
                {t('overview.activity.logs')}
              </th>
              <th scope="col" className={styles.number}>
                {t('overview.activity.openTasks')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.name}</th>
                <td className={styles.number}>
                  <Link
                    href={row.logsHref}
                    className={styles.link}
                    aria-label={t('overview.activity.logsLink', {
                      count: formatNumber(row.logsToday),
                      name: row.name,
                    })}
                  >
                    {formatNumber(row.logsToday)}
                  </Link>
                </td>
                <td className={styles.number}>
                  <Link
                    href={row.tasksHref}
                    className={styles.link}
                    aria-label={t('overview.activity.tasksLink', {
                      count: formatNumber(row.tasksOpen),
                      name: row.name,
                    })}
                  >
                    {formatNumber(row.tasksOpen)}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function IdleWorkers({ data }: Readonly<{ data: DashboardOverview }>) {
  const orgTime = useOrgTime();
  const { total, items, truncated } = data.idleWorkers;
  const title = t('overview.idle.heading');
  return (
    <section className={styles.panel} aria-label={title}>
      <h2 className={styles.panelTitle}>
        {title} · {t('overview.idle.count', { count: total })}
      </h2>
      <p className={styles.meta}>{t('overview.idle.description')}</p>
      {items.length === 0 ? (
        <EmptyState title={t('overview.idle.none')} />
      ) : (
        <table className={styles.table}>
          <caption className={styles.visuallyHidden}>{t('overview.idle.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('overview.idle.name')}</th>
              <th scope="col">{t('overview.idle.lastLog')}</th>
              <th scope="col">
                <span className={styles.visuallyHidden}>{t('overview.idle.openLogs')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((worker) => (
              <tr key={worker.userId}>
                <th scope="row">{worker.displayName}</th>
                <td>
                  {worker.lastLogAt ? orgTime.dateTime(worker.lastLogAt) : t('overview.idle.never')}
                </td>
                <td>
                  <Link
                    href={hrefWithFilter(WORK_LOGS_LIST_PATH, worker.filter)}
                    className={styles.link}
                    aria-label={t('overview.idle.openLogsOf', { name: worker.displayName })}
                  >
                    {t('overview.idle.openLogs')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {truncated ? (
        <p className={styles.meta}>
          {t('overview.idle.truncated', {
            shown: formatNumber(items.length),
            total: formatNumber(total),
          })}
        </p>
      ) : null}
    </section>
  );
}
