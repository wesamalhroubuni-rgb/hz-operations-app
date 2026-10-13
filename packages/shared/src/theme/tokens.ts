import { WCAG_AA } from './contrast.js';

/**
 * Brand design tokens: the one source of truth for colour, spacing, radius and type in the web
 * and mobile apps. Plain constants with no dependencies. The web app turns them into CSS custom
 * properties (see `css.ts`); the mobile app imports them directly.
 *
 * The colours are derived from the client's logo (`docs/brand/`): gold lettering and ring, a red
 * swoosh, on pure black. The gold and red were sampled from the logo's pixels. The brand is
 * black, so the theme is dark-first; a light theme would be a second `Theme` object next to
 * `darkTheme`.
 */
export interface ThemeColors {
  /** Page and screen background. Pure black, so the logo's own background blends into it. */
  background: string;
  /** Cards and panels on the background. */
  surface: string;
  /** Elements raised above a surface (hovered rows, inputs). */
  surfaceRaised: string;

  /** Decorative hairlines (card edges, dividers). Not relied on to identify a control. */
  border: string;
  /** Boundary of an interactive control (outlined buttons, inputs): at least 3:1. */
  borderStrong: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;

  /** The logo's gold, as sampled. Also passes AA as text on background and surface. */
  brandGold: string;
  /** The logo's red, as sampled. Decorative use only: it fails AA as normal text on black. */
  brandRed: string;

  /** Primary colour: filled buttons, links, key headings, the focus ring. */
  primary: string;
  /** Hover / pressed state of the primary colour. */
  primaryHover: string;
  /** Text and icons on a `primary` fill. */
  onPrimary: string;

  /** Accent for non-text decoration (rules, markers). Use sparingly. Same as `brandRed`. */
  accent: string;
  /** The accent lightened until it passes AA as normal text on background and surface. */
  accentText: string;

  /** Semantic status colours. Each passes AA as normal text on background and surface. */
  success: string;
  warning: string;
  danger: string;
  /** Informational and "in progress / pending" states. */
  info: string;
}

export interface Theme {
  name: string;
  scheme: 'dark' | 'light';
  colors: ThemeColors;
}

export const darkTheme: Theme = {
  name: 'dark',
  scheme: 'dark',
  colors: {
    background: '#000000',
    surface: '#141416',
    surfaceRaised: '#1E1E22',

    border: '#2E2E34',
    borderStrong: '#77777F',

    textPrimary: '#F5F1E8',
    textSecondary: '#CFC9BC',
    textMuted: '#A19C91',

    brandGold: '#D4A454',
    brandRed: '#D80611',

    primary: '#D4A454',
    primaryHover: '#ECC46C',
    onPrimary: '#14100A',

    accent: '#D80611',
    accentText: '#FF6B6E',

    success: '#4CC38A',
    warning: '#F5A04A',
    danger: '#FF6B6E',
    info: '#6CB6FF',
  },
};

/** Every available theme. Only a dark one exists today. */
export const themes = { dark: darkTheme } as const;

export const defaultTheme: Theme = darkTheme;

/** Shortcut for the default theme's colours. */
export const colors: ThemeColors = defaultTheme.colors;

/** Spacing scale in density-independent pixels (CSS px on the web). */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Corner radii in pixels. */
export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

/** Font sizes in pixels at the default text size (the web emits them in rem). */
export const fontSizes = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 24,
  xxl: 32,
} as const;

/** Font weights as strings, the form both CSS and React Native accept. */
export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export type ColorToken = keyof ThemeColors;

/** One foreground/background pairing the tokens are meant for, and the ratio it must reach. */
export interface ContrastRequirement {
  foreground: ColorToken;
  background: ColorToken;
  minimum: number;
  use: string;
}

const NORMAL_TEXT_COLORS: readonly ColorToken[] = [
  'textPrimary',
  'textSecondary',
  'textMuted',
  'primary',
  'primaryHover',
  'accentText',
  'success',
  'warning',
  'danger',
  'info',
];

const BACKDROPS: readonly ColorToken[] = ['background', 'surface', 'surfaceRaised'];

/**
 * The pairings every theme must satisfy (WCAG 2.x AA). The unit tests check each one, so a
 * colour change that breaks accessibility fails the build. Combine colours only as listed here.
 */
export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  ...NORMAL_TEXT_COLORS.flatMap((foreground) =>
    BACKDROPS.map((background): ContrastRequirement => ({
      foreground,
      background,
      minimum: WCAG_AA.normalText,
      use: 'normal text',
    })),
  ),
  {
    foreground: 'onPrimary',
    background: 'primary',
    minimum: WCAG_AA.normalText,
    use: 'text on a primary button',
  },
  {
    foreground: 'onPrimary',
    background: 'primaryHover',
    minimum: WCAG_AA.normalText,
    use: 'text on a hovered primary button',
  },
  ...(['background', 'surface'] as const).flatMap((background): ContrastRequirement[] => [
    {
      foreground: 'borderStrong',
      background,
      minimum: WCAG_AA.uiComponent,
      use: 'control boundary',
    },
    {
      foreground: 'accent',
      background,
      minimum: WCAG_AA.uiComponent,
      use: 'decorative accent and large text',
    },
    {
      foreground: 'primary',
      background,
      minimum: WCAG_AA.uiComponent,
      use: 'focus ring and filled control',
    },
  ]),
];
