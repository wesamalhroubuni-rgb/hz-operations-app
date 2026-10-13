/**
 * WCAG 2.x contrast maths. Pure functions; used by the token tests to prove the palette meets
 * WCAG AA, and available to the apps for any colour chosen at runtime.
 */

/** Minimum contrast ratios from WCAG 2.x, level AA. */
export const WCAG_AA = {
  /** Body text (below 18pt regular / 14pt bold). */
  normalText: 4.5,
  /** Large text (at least 18pt regular or 14pt bold). */
  largeText: 3,
  /** Boundaries of UI components and meaningful graphics (success criterion 1.4.11). */
  uiComponent: 3,
} as const;

function parseHex(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  const digits = match?.[1];
  if (digits === undefined) {
    throw new Error(`Expected a #rgb or #rrggbb colour, received "${color}"`);
  }
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function linearChannel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an opaque sRGB colour: 0 for black, 1 for white. */
export function relativeLuminance(color: string): number {
  const [red, green, blue] = parseHex(color);
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

/**
 * Contrast ratio between two opaque colours, from 1 (identical) to 21 (black on white). The
 * order of the arguments does not change the result.
 */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
