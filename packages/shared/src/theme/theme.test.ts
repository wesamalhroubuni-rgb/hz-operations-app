import { describe, expect, it } from 'vitest';

import { contrastRatio, relativeLuminance, WCAG_AA } from './contrast.js';
import { themeCss, themeCssVariables } from './css.js';
import { CONTRAST_REQUIREMENTS, darkTheme, themes } from './tokens.js';

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#D4A454', '#D4A454')).toBe(1);
  });

  it('does not depend on the argument order', () => {
    expect(contrastRatio('#D4A454', '#000000')).toBe(contrastRatio('#000000', '#D4A454'));
  });

  it('matches published reference values', () => {
    // #767676 on white is the well-known lightest grey that passes AA for normal text.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#ff0000', '#ffffff')).toBeCloseTo(4.0, 1);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000')).toBe(0);
  });

  it('accepts short hex and ignores case and surrounding spaces', () => {
    expect(contrastRatio(' #FFF ', '#000')).toBeCloseTo(21, 5);
  });

  it('rejects anything that is not a hex colour', () => {
    expect(() => contrastRatio('gold', '#000000')).toThrow(/#rgb or #rrggbb/);
    expect(() => contrastRatio('#12345', '#000000')).toThrow();
  });
});

describe.each(Object.values(themes))('theme "$name" meets WCAG AA', (theme) => {
  it.each(CONTRAST_REQUIREMENTS)(
    '$foreground on $background is at least $minimum:1 ($use)',
    ({ foreground, background, minimum }) => {
      const ratio = contrastRatio(theme.colors[foreground], theme.colors[background]);
      expect(ratio).toBeGreaterThanOrEqual(minimum);
    },
  );

  it('uses only opaque six-digit hex colours', () => {
    for (const value of Object.values(theme.colors)) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe('brand colours', () => {
  it('keeps the sampled logo gold usable as normal text on black', () => {
    const { brandGold, background } = darkTheme.colors;
    expect(contrastRatio(brandGold, background)).toBeGreaterThanOrEqual(WCAG_AA.normalText);
  });

  it('documents that the sampled logo red is decorative: it fails as normal text', () => {
    const { brandRed, accentText, background, surface } = darkTheme.colors;
    expect(contrastRatio(brandRed, background)).toBeLessThan(WCAG_AA.normalText);
    expect(contrastRatio(brandRed, background)).toBeGreaterThanOrEqual(WCAG_AA.largeText);
    expect(contrastRatio(accentText, surface)).toBeGreaterThanOrEqual(WCAG_AA.normalText);
  });
});

describe('themeCssVariables', () => {
  const variables = themeCssVariables();

  it('exposes every colour as a kebab-case custom property', () => {
    expect(variables['--color-background']).toBe(darkTheme.colors.background);
    expect(variables['--color-text-primary']).toBe(darkTheme.colors.textPrimary);
    expect(variables['--color-on-primary']).toBe(darkTheme.colors.onPrimary);
    const colourNames = Object.keys(variables).filter((name) => name.startsWith('--color-'));
    expect(colourNames).toHaveLength(Object.keys(darkTheme.colors).length);
  });

  it('emits spacing and radii in px, font sizes in rem, and weights as numbers', () => {
    expect(variables['--space-lg']).toBe('16px');
    expect(variables['--radius-md']).toBe('10px');
    expect(variables['--font-size-md']).toBe('1rem');
    expect(variables['--font-size-sm']).toBe('0.875rem');
    expect(variables['--font-weight-bold']).toBe('700');
  });

  it('renders a :root rule with the colour scheme', () => {
    const css = themeCss();
    expect(css.startsWith(':root {\n  color-scheme: dark;\n')).toBe(true);
    expect(css).toContain('  --color-primary: #D4A454;\n');
    expect(themeCss(darkTheme, '[data-theme="dark"]')).toContain('[data-theme="dark"] {');
  });
});
