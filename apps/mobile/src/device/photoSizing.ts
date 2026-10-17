// The phone-side photo rules: how large a photo is sent, at what JPEG quality, how many per log.
// Pure, so the numbers are tested and live in one place.

/** The long edge of an uploaded photo, in pixels. Enough to read a label or a meter; ~300-600 KB. */
export const PHOTO_MAX_EDGE_PX = 1600;

/** JPEG quality of an uploaded photo (0..1). */
export const PHOTO_JPEG_QUALITY = 0.7;

/** Photos one log may carry. */
export const MAX_PHOTOS_PER_LOG = 10;

/**
 * The resize to apply so the long edge is at most `maxEdge`, keeping the aspect ratio. Only one
 * side is given (the other follows). Null when the photo is already small enough: it is then only
 * re-encoded, never enlarged.
 */
export function resizeFor(
  width: number,
  height: number,
  maxEdge = PHOTO_MAX_EDGE_PX,
): { width: number } | { height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  if (Math.max(width, height) <= maxEdge) return null;
  return width >= height ? { width: maxEdge } : { height: maxEdge };
}

/** How many more photos may be added to a log that has `current` already. */
export function remainingPhotoSlots(current: number, max = MAX_PHOTOS_PER_LOG): number {
  return Math.max(0, max - current);
}

/** A file name for an uploaded photo: `photo-<date>-<n>.jpg`, no personal data. */
export function photoFileName(takenAt: Date, index: number): string {
  const stamp = takenAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `photo-${stamp}-${index + 1}.jpg`;
}
