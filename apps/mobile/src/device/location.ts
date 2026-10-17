import * as Location from 'expo-location';

import {
  LAST_KNOWN_MAX_AGE_MS,
  LOCATION_TIMEOUT_MS,
  toWorkLogLocation,
  withTimeout,
  type LocationCapture,
} from './locationLogic';

/**
 * Captures where the phone is, for a new log. Asks for permission only the first time (the
 * system remembers the answer; a denial is never asked again here). Answers within
 * `LOCATION_TIMEOUT_MS`: a recent last-known fix shows at once, a fresh fix replaces it when it
 * is more accurate. Never throws; the caller saves the log whatever this answers.
 */
export async function captureLocation(
  onUpdate: (capture: LocationCapture) => void,
  timeoutMs = LOCATION_TIMEOUT_MS,
): Promise<LocationCapture> {
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
    if (!permission.granted) {
      const denied: LocationCapture = { status: 'denied' };
      onUpdate(denied);
      return denied;
    }
    if (!(await Location.hasServicesEnabledAsync())) {
      const off: LocationCapture = { status: 'unavailable' };
      onUpdate(off);
      return off;
    }

    const lastKnown = toWorkLogLocation(
      await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }).catch(() => null),
    );
    if (lastKnown) onUpdate({ status: 'captured', location: lastKnown });

    const fresh = toWorkLogLocation(
      await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
        timeoutMs,
        null,
      ),
    );
    // A fresh fix wins: the last-known one may be from before the worker moved.
    const best = fresh ?? lastKnown;
    const capture: LocationCapture = best
      ? { status: 'captured', location: best }
      : { status: 'unavailable' };
    onUpdate(capture);
    return capture;
  } catch {
    const failed: LocationCapture = { status: 'unavailable' };
    onUpdate(failed);
    return failed;
  }
}
