import { defaultTheme, fontSizes, fontWeights, radii, spacing, type Theme } from './tokens.js';

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * The tokens as CSS custom properties, for example `--color-text-primary`, `--space-lg`,
 * `--radius-md`, `--font-size-sm`, `--font-weight-bold`. The web app sets them once on the root
 * element and its stylesheets only ever use `var(--...)`, so the values live in one place.
 * Spacing and radii are emitted in px; font sizes in rem so they follow the user's text size.
 */
export function themeCssVariables(theme: Theme = defaultTheme): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(theme.colors)) {
    variables[`--color-${kebab(name)}`] = value;
  }
  for (const [name, value] of Object.entries(spacing)) {
    variables[`--space-${name}`] = `${value}px`;
  }
  for (const [name, value] of Object.entries(radii)) {
    variables[`--radius-${name}`] = `${value}px`;
  }
  for (const [name, value] of Object.entries(fontSizes)) {
    variables[`--font-size-${name}`] = `${value / 16}rem`;
  }
  for (const [name, value] of Object.entries(fontWeights)) {
    variables[`--font-weight-${name}`] = value;
  }
  return variables;
}

/** The same variables as a stylesheet rule: `:root { --color-background: #000000; ... }`. */
export function themeCss(theme: Theme = defaultTheme, selector = ':root'): string {
  const declarations = Object.entries(themeCssVariables(theme))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n  color-scheme: ${theme.scheme};\n${declarations}\n}\n`;
}
