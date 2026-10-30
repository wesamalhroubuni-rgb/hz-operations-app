import type { ReactNode } from 'react';

export type MarkerTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

export interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  /** Short text on hover and for screen readers ("Deniz · 14:05"). */
  title: string;
  tone?: MarkerTone;
  /** GPS accuracy radius in metres, drawn as a faint circle when given. */
  accuracy?: number | null;
}

export interface MapViewProps {
  markers: readonly MapMarker[];
  /** Accessible name of the map region, e.g. "Map of recent work logs". */
  ariaLabel: string;
  /** `sm` 240 px (a log's detail), `md` 400 px, `lg` 70% of the viewport (the map page). */
  height?: 'sm' | 'md' | 'lg';
  /** Popup content of a marker (e.g. a link to the log). */
  renderPopup?: (marker: MapMarker) => ReactNode;
  onMarkerClick?: (marker: MapMarker) => void;
  /** Zoom to fit the markers (default true); a single marker zooms to `singleZoom`. */
  fitToMarkers?: boolean;
  singleZoom?: number;
}
