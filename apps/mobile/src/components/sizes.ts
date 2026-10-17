/**
 * Touch-target sizes in dp. Layout sizes, not design tokens: the tokens in `@ops/shared` hold
 * colour, spacing, radius and type. Field work means gloves, sunlight and one hand, so targets
 * are larger than the 48 dp platform minimum wherever there is room.
 */
export const touch = {
  /** The minimum for anything tappable (WCAG 2.5.5 / Material). */
  min: 48,
  /** Ordinary buttons and list rows. */
  comfortable: 56,
  /** The main action of a screen ("New log", "Save log"). */
  primary: 64,
} as const;

/** Icon sizes in dp. */
export const iconSize = {
  sm: 20,
  md: 24,
  lg: 28,
} as const;

/** Thumbnails of photos in a log, in dp. */
export const thumbnailSize = 96;
