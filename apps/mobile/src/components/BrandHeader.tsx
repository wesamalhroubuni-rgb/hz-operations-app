import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { Image, StyleSheet, Text, View } from 'react-native';

import { brand } from '../config/brand';

/** The logo, the product name and the app label. `compact` is the smaller form above a form. */
export function BrandHeader({ compact = false }: Readonly<{ compact?: boolean }>) {
  return (
    <View style={styles.header}>
      <Image
        source={brand.logo.source}
        style={compact ? styles.logoCompact : styles.logo}
        accessible
        accessibilityRole="image"
        accessibilityLabel={brand.logo.accessibilityLabel}
      />
      <Text style={[styles.title, compact && styles.titleCompact]} accessibilityRole="header">
        {brand.name}
      </Text>
      <Text style={styles.label}>{brand.appLabel}</Text>
      {compact ? null : <View style={styles.rule} />}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
  },
  logo: {
    width: 128,
    height: 128,
  },
  logoCompact: {
    width: 96,
    height: 96,
  },
  title: {
    marginTop: spacing.sm,
    fontSize: fontSizes.xxl,
    fontWeight: fontWeights.bold,
    letterSpacing: 1,
    color: colors.primary,
  },
  titleCompact: {
    fontSize: fontSizes.xl,
  },
  label: {
    marginTop: spacing.xs,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  // The one use of the brand red: a short decorative rule, never text.
  rule: {
    marginTop: spacing.lg,
    width: 48,
    height: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
});
