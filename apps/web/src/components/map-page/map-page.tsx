'use client';

import { WORK_LOG_MAP_DEFAULT_DAYS, type WorkLogMapPoint } from '@ops/shared';
import Link from 'next/link';
import { useMemo } from 'react';

import { MapView, type MapMarker } from '@/components/map/map-view';
import { ButtonLink } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/layout';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { WorkLogFilters } from '@/components/work-logs/work-log-filters';
import { useDirectory } from '@/hooks/use-directory';
import { useListParams } from '@/hooks/use-list-params';
import { useOrgTime } from '@/hooks/use-organization';
import { useWorkLogMap } from '@/hooks/use-work-logs';
import { formatNumber, t } from '@/i18n';
import { hrefWithFilter } from '@/lib/list-params';
import {
  mapQueryOf,
  WORK_LOG_LIST_FILTER_KEYS,
  WORK_LOGS_PATH,
  workLogHref,
} from '@/lib/work-logs/filters';
import { markerToneOf } from '@/lib/work-logs/map-points';

import styles from './map-page.module.css';

/**
 * `/map`: recent located work logs within the filters (`GET /work-logs/map`: newest first, the
 * last 7 days by default, at most 500 points). Each marker's popup links to the log; the same
 * points are listed below as text, so the map is never the only way to reach them.
 */
export function MapPage() {
  const list = useListParams(WORK_LOG_LIST_FILTER_KEYS);
  const orgTime = useOrgTime();
  const names = useDirectory();
  const query = useWorkLogMap(mapQueryOf(list.state.filters));
  const data = query.data;

  const byId = useMemo(
    () => new Map((data?.items ?? []).map((point) => [point.id, point])),
    [data],
  );
  const markers = useMemo<MapMarker[]>(
    () =>
      (data?.items ?? []).map((point) => ({
        id: point.id,
        latitude: point.latitude,
        longitude: point.longitude,
        accuracy: point.accuracy,
        tone: markerToneOf(point.status),
        title: `${names.user(point.authorId)} · ${orgTime.dateTime(point.occurredAt)} · ${t(`status.workLog.${point.status}`)}`,
      })),
    [data, names, orgTime],
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('pages.map.title')}
        description={t('mapPage.description')}
        actions={
          <ButtonLink href={hrefWithFilter(WORK_LOGS_PATH, list.state.filters)}>
            {t('nav.workLogs')}
          </ButtonLink>
        }
      />
      <WorkLogFilters list={list} names={names} orgTime={orgTime} withSearch withArchived={false} />
      {data ? (
        <p className={styles.meta} aria-live="polite">
          {t('mapPage.shown', { count: data.items.length })}
          {' · '}
          {t('mapPage.range', {
            from: orgTime.dateTime(data.occurredFrom),
            to: orgTime.dateTime(data.occurredTo),
          })}
          {!list.state.filters.occurredFrom ? (
            <> · {t('mapPage.defaultRange', { days: WORK_LOG_MAP_DEFAULT_DAYS })}</>
          ) : null}
        </p>
      ) : null}
      {data?.truncated ? (
        <p className={styles.notice} role="note">
          {t('mapPage.truncated', {
            shown: formatNumber(data.items.length),
            total: formatNumber(data.total),
          })}
        </p>
      ) : null}
      {query.isLoading ? <LoadingState /> : null}
      {!data && query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {data ? (
        <>
          <MapView
            height="lg"
            ariaLabel={t('mapPage.mapLabel')}
            markers={markers}
            renderPopup={(marker) => {
              const point = byId.get(marker.id);
              return point ? <PointPopup point={point} /> : null;
            }}
          />
          <PointList points={data.items} />
        </>
      ) : null}
    </div>
  );
}

function PointPopup({ point }: Readonly<{ point: WorkLogMapPoint }>) {
  const orgTime = useOrgTime();
  const names = useDirectory();
  return (
    <div className={styles.popup}>
      <strong>{names.user(point.authorId)}</strong>
      <span>{orgTime.dateTime(point.occurredAt)}</span>
      <span>
        {t(`status.workLog.${point.status}`)}
        {point.attachmentCount > 0
          ? ` · ${t('mapPage.popupPhotos', { count: point.attachmentCount })}`
          : ''}
      </span>
      {point.excerpt ? <span>{point.excerpt}</span> : null}
      <Link href={workLogHref(point.id)} className={styles.popupLink}>
        {t('mapPage.openLog')}
      </Link>
    </div>
  );
}

function PointList({ points }: Readonly<{ points: readonly WorkLogMapPoint[] }>) {
  const orgTime = useOrgTime();
  const names = useDirectory();
  const title = t('mapPage.listHeading');
  if (points.length === 0) {
    return <EmptyState title={t('mapPage.empty')} />;
  }
  return (
    <section className={styles.panel} aria-label={title}>
      <h2 className={styles.panelTitle}>{title}</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={styles.visuallyHidden}>{t('mapPage.listCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('workLogs.table.occurredAt')}</th>
              <th scope="col">{t('workLogs.table.worker')}</th>
              <th scope="col">{t('workLogs.table.site')}</th>
              <th scope="col">{t('workLogs.table.status')}</th>
              <th scope="col">{t('mapPage.coordinates')}</th>
              <th scope="col">{t('workLogs.table.text')}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.id}>
                <td>
                  <Link href={workLogHref(point.id)} className={styles.link}>
                    {orgTime.dateTime(point.occurredAt)}
                  </Link>
                </td>
                <td>{names.user(point.authorId)}</td>
                <td>{names.site(point.siteId)}</td>
                <td>
                  <StatusBadge kind="workLog" value={point.status} />
                </td>
                <td className={styles.coordinates}>
                  {formatNumber(point.latitude, 5)}, {formatNumber(point.longitude, 5)}
                </td>
                <td>{point.excerpt ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
