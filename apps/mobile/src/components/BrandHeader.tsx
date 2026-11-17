import { fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { Image, Text, View } from 'react-native';

import { brand } from '../config/brand';
import { makeStyles } from '../theme';

/**
 * The logo and the app label. The logo already shows the product name, so it is not repeated as
 * text; screen readers get it from the logo's label. `compact` is the smaller form above a form.
 */
export function BrandHeader({ compact = false }: Readonly<{ compact?: boolean }>) {
  const styles = useStyles();
  return (
    <View style={styles.header}>
      <Image
        source={brand.logo.source}
        style={compact ? styles.logoCompact : styles.logo}
        accessible
        accessibilityRole="image"
        accessibilityLabel={brand.logo.accessibilityLabel}
      />
      <Text style={styles.label} accessibilityRole="header">
        {brand.appLabel}
      </Text>
      {compact ? null : <View style={styles.rule} />}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  header: {
    alignItems: 'center',
  },
  // The logo is a black square: rounded, it reads as a tile on the light theme and blends into
  // the black background of the dark one.
  logo: {
    width: 128,
    height: 128,
    borderRadius: radii.lg,
  },
  logoCompact: {
    width: 96,
    height: 96,
    borderRadius: radii.md,
  },
  label: {
    marginTop: spacing.md,
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
}));
