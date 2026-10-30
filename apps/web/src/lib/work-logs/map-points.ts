import type { WorkLogStatus } from '@ops/shared';

import type { MarkerTone } from '@/components/map/map-types';

/**
 * Marker colour by status, the same tones as the status badges. The colour is never the only
 * signal: the marker's title, its popup and the list below the map say the status in words.
 */
const TONES: Record<WorkLogStatus, MarkerTone> = {
  draft: 'muted',
  submitted: 'warning',
  approved: 'success',
  rejected: 'danger',
};

export function markerToneOf(status: WorkLogStatus): MarkerTone {
  return TONES[status];
}
