import { fontSizes, spacing } from '@ops/shared';
import { ActivityIndicator, Image, Text, View } from 'react-native';

import { brand } from '../config/brand';
import { t } from '../i18n';
import { makeStyles, useTheme } from '../theme';

/**
 * Shown while the stored session is read from SecureStore and checked with the API: the logo on
 * the black brand background (like the splash screen), so it shows no tile.
 */
export function LoadingScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.screen}>
      <Image
        source={brand.logo.source}
        style={styles.logo}
        accessible
        accessibilityRole="image"
        accessibilityLabel={brand.logo.accessibilityLabel}
      />
      <View accessible accessibilityRole="progressbar" style={styles.status}>
        <ActivityIndicator color={colors.brandGold} size="small" />
        <Text style={styles.text}>{t('auth.checkingSession')}</Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxl,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.brandInk,
  },
  logo: {
    width: 140,
    height: 140,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  text: {
    fontSize: fontSizes.md,
    color: colors.onBrandInkMuted,
  },
}));
