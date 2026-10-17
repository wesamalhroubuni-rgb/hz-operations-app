import { colors, fontSizes, spacing } from '@ops/shared';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandHeader } from '../components/BrandHeader';
import { t } from '../i18n';

/** Shown while the stored session is read from SecureStore and checked with the API. */
export function LoadingScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <BrandHeader />
      <View accessible accessibilityRole="progressbar" style={styles.status}>
        <ActivityIndicator color={colors.primary} size="small" />
        <Text style={styles.text}>{t('auth.checkingSession')}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxl,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.background,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  text: {
    fontSize: fontSizes.md,
    color: colors.textSecondary,
  },
});
