'use client';

import 'leaflet/dist/leaflet.css';

import { useEffect, useMemo } from 'react';
import {
  Circle,
  CircleMarker,
  MapContainer,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet';

import { boundsOf, DEFAULT_MAP_VIEW, mapTiles } from '@/lib/map';

import type { MapMarker, MapViewProps, MarkerTone } from './map-types';

const TONE_VARIABLE: Record<MarkerTone, string> = {
  primary: '--color-primary',
  success: '--color-success',
  warning: '--color-warning',
  danger: '--color-danger',
  info: '--color-info',
  muted: '--color-text-muted',
};

/** The token colours, read from the CSS variables on <html> (no colour is written here). */
function toneColors(): Record<MarkerTone, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(TONE_VARIABLE).map(([tone, variable]) => [
      tone,
      style.getPropertyValue(variable).trim(),
    ]),
  ) as Record<MarkerTone, string>;
}

function FitBounds({
  markers,
  singleZoom,
}: Readonly<{ markers: readonly MapMarker[]; singleZoom: number }>) {
  const map = useMap();
  const key = markers.map((marker) => marker.id).join(',');
  useEffect(() => {
    const bounds = boundsOf(markers);
    if (bounds === null) {
      return;
    }
    if (markers.length === 1) {
      map.setView(bounds[0], singleZoom);
    } else {
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    }
    // Refit only when the set of markers changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key, singleZoom]);
  return null;
}

/**
 * The Leaflet map itself. Loaded only in the browser (`MapView` imports it with
 * `next/dynamic`, `ssr: false`): Leaflet touches `window` at import time. Markers are circle
 * markers (vector, no image files), coloured from the design tokens.
 */
export default function LeafletMap({
  markers,
  renderPopup,
  onMarkerClick,
  fitToMarkers = true,
  singleZoom = 15,
}: Readonly<MapViewProps>) {
  const colors = useMemo(() => toneColors(), []);
  return (
    <MapContainer
      center={DEFAULT_MAP_VIEW.center}
      zoom={DEFAULT_MAP_VIEW.zoom}
      style={{ blockSize: '100%', inlineSize: '100%' }}
      scrollWheelZoom={false}
    >
      <TileLayer url={mapTiles.url} attribution={mapTiles.attribution} maxZoom={mapTiles.maxZoom} />
      {fitToMarkers ? <FitBounds markers={markers} singleZoom={singleZoom} /> : null}
      {markers.map((marker) => {
        const color = colors[marker.tone ?? 'primary'];
        const center: [number, number] = [marker.latitude, marker.longitude];
        return (
          <CircleMarker
            key={marker.id}
            center={center}
            radius={8}
            pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 2 }}
            eventHandlers={onMarkerClick ? { click: () => onMarkerClick(marker) } : undefined}
          >
            <Tooltip>{marker.title}</Tooltip>
            {renderPopup ? <Popup>{renderPopup(marker)}</Popup> : null}
            {marker.accuracy ? (
              <Circle
                center={center}
                radius={marker.accuracy}
                pathOptions={{ color, weight: 1, fillOpacity: 0.08 }}
              />
            ) : null}
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
