import { colors, fontSizes, fontWeights } from '@ops/shared';
import { StyleSheet, Text, type TextProps } from 'react-native';

export type TextVariant =
  'title' | 'heading' | 'body' | 'bodyStrong' | 'secondary' | 'muted' | 'label' | 'small';

/**
 * Text in one of the app's styles. Font scaling follows the phone's text-size setting (never
 * capped here); `textAlign: 'auto'` follows the language direction.
 */
export function AppText({
  variant = 'body',
  style,
  ...props
}: Readonly<TextProps & { variant?: TextVariant }>) {
  return (
    <Text
      accessibilityRole={variant === 'title' || variant === 'heading' ? 'header' : undefined}
      {...props}
      style={[styles.base, styles[variant], style]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    color: colors.textPrimary,
    textAlign: 'auto',
    writingDirection: 'auto',
  },
  title: {
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
  },
  heading: {
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.semibold,
  },
  body: {
    fontSize: fontSizes.md,
    lineHeight: fontSizes.md * 1.4,
  },
  bodyStrong: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    lineHeight: fontSizes.md * 1.4,
  },
  secondary: {
    fontSize: fontSizes.md,
    color: colors.textSecondary,
    lineHeight: fontSizes.md * 1.4,
  },
  muted: {
    fontSize: fontSizes.sm,
    color: colors.textMuted,
    lineHeight: fontSizes.sm * 1.4,
  },
  label: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    color: colors.textSecondary,
  },
  small: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
    lineHeight: fontSizes.sm * 1.4,
  },
});
