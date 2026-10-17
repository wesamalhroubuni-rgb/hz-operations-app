import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '@ops/shared';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { t } from '../i18n';
import { AppText } from './AppText';
import { Button, type IconName } from './Button';
import { iconSize } from './sizes';

/** A spinner with a word, announced to screen readers. */
export function LoadingState({ label = t('common.loading') }: Readonly<{ label?: string }>) {
  return (
    <View style={styles.box} accessible accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.primary} size="large" />
      <AppText variant="secondary">{label}</AppText>
    </View>
  );
}

/** What went wrong, with a button that tries again. */
export function ErrorState({
  message = t('errors.loadFailed'),
  onRetry,
}: Readonly<{ message?: string; onRetry?: () => void }>) {
  return (
    <View style={styles.box}>
      <Ionicons name="cloud-offline-outline" size={iconSize.lg} color={colors.danger} />
      <AppText variant="secondary" style={styles.center} accessibilityRole="alert">
        {message}
      </AppText>
      {onRetry ? (
        <Button variant="secondary" label={t('common.retry')} onPress={onRetry} icon="refresh" />
      ) : null}
    </View>
  );
}

/** An empty list: say so plainly, and offer the next step when there is one. */
export function EmptyState({
  message,
  icon = 'file-tray-outline',
  actionLabel,
  onAction,
}: Readonly<{ message: string; icon?: IconName; actionLabel?: string; onAction?: () => void }>) {
  return (
    <View style={styles.box}>
      <Ionicons name={icon} size={iconSize.lg} color={colors.textMuted} />
      <AppText variant="secondary" style={styles.center}>
        {message}
      </AppText>
      {actionLabel && onAction ? <Button label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  center: {
    textAlign: 'center',
  },
});
