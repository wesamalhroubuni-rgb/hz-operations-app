// Whether this phone and this build can receive remote push notifications. Pure.
//
// Facts (expo-notifications 57, read from its source and changelog):
// - Android in Expo Go: remote push was removed in SDK 53; asking for a push token throws.
//   A development build is needed. Local notifications and the in-app list still work.
// - iOS in Expo Go: remote push still works (with a warning), given an EAS project id.
// - Simulators and emulators cannot get a push token.
// - Without an EAS project id, `getExpoPushTokenAsync` throws.

export type PushUnavailableReason = 'expoGo' | 'simulator' | 'noProjectId';

export type PushAvailability =
  { available: true; projectId: string } | { available: false; reason: PushUnavailableReason };

export interface PushEnvironment {
  platform: string;
  isDevice: boolean;
  inExpoGo: boolean;
  projectId: string | null;
}

export function pushAvailability(environment: PushEnvironment): PushAvailability {
  if (environment.platform !== 'ios' && environment.platform !== 'android') {
    return { available: false, reason: 'simulator' };
  }
  if (!environment.isDevice) return { available: false, reason: 'simulator' };
  if (environment.inExpoGo && environment.platform === 'android') {
    return { available: false, reason: 'expoGo' };
  }
  const projectId = environment.projectId?.trim();
  if (!projectId) return { available: false, reason: 'noProjectId' };
  return { available: true, projectId };
}

/** The first non-empty project id of the candidates (env first, then the app config). */
export function resolveProjectId(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (trimmed) return trimmed;
  }
  return null;
}
