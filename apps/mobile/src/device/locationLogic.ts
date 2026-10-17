import type { WorkLogLocationInput } from '@ops/shared';

// The pure part of location capture: turning a position into the log's location, racing it
// against a timeout, and choosing between a fresh and a last-known fix.

export type LocationCapture =
  | { status: 'capturing' }
  | { status: 'captured'; location: WorkLogLocationInput }
  | { status: 'denied' }
  | { status: 'unavailable' };

/** How long the form waits for a fix before saying "not available". Saving never waits. */
export const LOCATION_TIMEOUT_MS = 10_000;

/** A last-known fix younger than this is good enough to show at once. */
export const LAST_KNOWN_MAX_AGE_MS = 2 * 60 * 1000;

interface PositionLike {
  coords: { latitude: number; longitude: number; accuracy: number | null };
}

/** The log's location from a platform position; null for coordinates the API would refuse. */
export function toWorkLogLocation(
  position: PositionLike | null | undefined,
): WorkLogLocationInput | null {
  if (!position) return null;
  const { latitude, longitude, accuracy } = position.coords;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return {
    latitude,
    longitude,
    accuracy:
      typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
  };
}

/** Resolves with the promise's value, or with `fallback` after `ms`. Never rejects. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
