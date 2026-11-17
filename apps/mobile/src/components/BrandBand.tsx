import { fontSizes, fontWeights, spacing } from '@ops/shared';
import type { ReactNode } from 'react';
import { Image, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { brand } from '../config/brand';
import { makeStyles } from '../theme';

/**
 * The brand area at the top of a screen: the logo on its own black (`brandInk`, the same in every
 * theme, so the logo shows no tile), the organization's name and a small label, and an optional
 * element at the end (the sync status). `safeTop` pads it under the status bar when the screen has
 * no navigation header.
 */
export function BrandBand({
  title,
  subtitle,
  end,
  safeTop = false,
}: Readonly<{ title: string; subtitle?: string; end?: ReactNode; safeTop?: boolean }>) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.band, safeTop ? { paddingTop: insets.top + spacing.md } : null]}>
      <Image
        source={brand.logo.source}
        style={styles.logo}
        accessible
        accessibilityRole="image"
        accessibilityLabel={brand.logo.accessibilityLabel}
      />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {end ? <View style={styles.end}>{end}</View> : null}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.brandInk,
  },
  logo: {
    width: 44,
    height: 44,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.bold,
    color: colors.onBrandInk,
    textAlign: 'auto',
  },
  subtitle: {
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.onBrandInkMuted,
    textAlign: 'auto',
  },
  end: {
    flexShrink: 0,
  },
}));
