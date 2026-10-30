'use client';

import dynamic from 'next/dynamic';

import { t } from '@/i18n';

import styles from './map.module.css';
import type { MapViewProps } from './map-types';

export type { MapMarker, MapViewProps, MarkerTone } from './map-types';

const LeafletMap = dynamic(() => import('./leaflet-map'), {
  ssr: false,
  loading: () => <div className={styles.placeholder}>{t('map.loading')}</div>,
});

/**
 * A map of points (ADR-0009): Leaflet + OpenStreetMap tiles, client-only (never rendered on the
 * server). Use it for the map page (`height="lg"`) and a log's location (`height="sm"`).
 * With no markers it shows a "No locations" message instead of an empty world.
 *
 * Keyboard and screen readers: the map is a labelled region; every point is also in the page's
 * list or detail text, so the map is never the only way to reach the data.
 */
export function MapView(props: Readonly<MapViewProps>) {
  const height = props.height ?? 'md';
  return (
    <div
      className={`${styles.map} ${styles[height] ?? ''}`}
      role="region"
      aria-label={props.ariaLabel}
    >
      {props.markers.length === 0 ? (
        <div className={styles.placeholder}>{t('map.noLocations')}</div>
      ) : (
        <LeafletMap {...props} />
      )}
    </div>
  );
}
