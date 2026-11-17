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

  /**
   * The brand area (the dashboard's sidebar, the phone's top band and sign-in hero): the logo's
   * own black in every theme, so the logo sits on it without a visible tile.
   */
  brandInk: string;
  /** Text and icons on randInk. */
  onBrandInk: string;
  /** Secondary text on randInk. */
  onBrandInkMuted: string;
  /** A raised or selected item on randInk (the active sidebar link). */
  brandInkRaised: string;
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

    brandInk: '#000000',
    onBrandInk: '#F5F1E8',
    onBrandInkMuted: '#B3AC9F',
    brandInkRaised: '#1C1A17',
  },
};

/**
 * The light theme, used when the device or browser is set to light mode. Warm neutrals that sit
 * well next to the logo (a black tile with gold lettering); the gold is darkened until it passes
 * AA as text on white, and the logo red keeps its sampled value as a decorative accent.
 */
export const lightTheme: Theme = {
  name: 'light',
  scheme: 'light',
  colors: {
    background: '#F7F6F3',
    surface: '#FFFFFF',
    surfaceRaised: '#F1EFEA',

    border: '#E3E0D8',
    borderStrong: '#8A8578',

    textPrimary: '#1A1814',
    textSecondary: '#4A463E',
    textMuted: '#625D53',

    brandGold: '#D4A454',
    brandRed: '#D80611',

    primary: '#8A6416',
    primaryHover: '#6F500F',
    onPrimary: '#FFFFFF',

    accent: '#D80611',
    accentText: '#B0050E',

    success: '#1D7046',
    warning: '#9A4F06',
    danger: '#B42318',
    info: '#1F64AD',

    brandInk: '#000000',
    onBrandInk: '#F5F1E8',
    onBrandInkMuted: '#B3AC9F',
    brandInkRaised: '#1C1A17',
  },
};

/** Every available theme. The apps follow the device's light or dark setting. */
export const themes = { dark: darkTheme, light: lightTheme } as const;

/** The theme for a colour scheme reported by the device or browser (unknown = dark). */
export function themeForScheme(scheme: 'light' | 'dark' | null | undefined): Theme {
  return scheme === 'light' ? lightTheme : darkTheme;
}

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
  ...(['onBrandInk', 'onBrandInkMuted', 'brandGold'] as const).flatMap(
    (foreground): ContrastRequirement[] =>
      (['brandInk', 'brandInkRaised'] as const).map((background) => ({
        foreground,
        background,
        minimum: WCAG_AA.normalText,
        use: 'text in the brand area',
      })),
  ),
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
