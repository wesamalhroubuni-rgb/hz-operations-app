import { env } from './env';

/**
 * Map tiles (ADR-0009): Leaflet with OpenStreetMap's public tiles by default, which need no key
 * and are fine for development and light use; their usage policy requires the attribution and
 * forbids heavy use, so production sets `NEXT_PUBLIC_MAP_TILE_URL` to its own provider.
 */
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const mapTiles = {
  url: env.mapTileUrl ?? OSM_TILE_URL,
  /** HTML attribution shown in the map corner (Leaflet renders it). */
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
} as const;

/** Centre and zoom when there is nothing to show (Istanbul). */
export const DEFAULT_MAP_VIEW = { center: [41.0082, 28.9784] as [number, number], zoom: 10 };

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** The south-west and north-east corners around points, or null for none. */
export function boundsOf(points: readonly LatLng[]): [[number, number], [number, number]] | null {
  const valid = points.filter(
    (point) =>
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      Math.abs(point.latitude) <= 90 &&
      Math.abs(point.longitude) <= 180,
  );
  if (valid.length === 0) {
    return null;
  }
  let south = 90;
  let west = 180;
  let north = -90;
  let east = -180;
  for (const point of valid) {
    south = Math.min(south, point.latitude);
    north = Math.max(north, point.latitude);
    west = Math.min(west, point.longitude);
    east = Math.max(east, point.longitude);
  }
  return [
    [south, west],
    [north, east],
  ];
}
