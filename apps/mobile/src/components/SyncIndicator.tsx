import { Ionicons } from '@expo/vector-icons';
import { fontSizes, fontWeights, spacing } from '@ops/shared';
import { useNavigation } from '@react-navigation/native';
import { Pressable, StyleSheet, Text } from 'react-native';

import { t } from '../i18n';
import { syncText } from '../i18n/syncText';
import { statusPresentation } from '../logic/sync';
import { TONE_COLORS } from './Badge';
import { iconSize, touch } from './sizes';
import { useSync } from './SyncProvider';

/**
 * The small sync status in the header of the tabs: synced / waiting N / not accepted N /
 * offline / sign in again. Tapping it opens the Sync screen. Hidden without an offline layer.
 */
export function SyncIndicator() {
  const { available, status } = useSync();
  const navigation = useNavigation();
  if (!available || status === null) return null;
  const view = statusPresentation(status);
  const label = syncText(view.text);
  const color = TONE_COLORS[view.tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('sync.indicatorLabel', { status: label })}
      hitSlop={spacing.sm}
      onPress={() => navigation.navigate('Sync')}
      style={({ pressed }) => [styles.box, pressed && styles.pressed]}
    >
      <Ionicons name={view.icon} size={iconSize.sm} color={color} />
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    maxWidth: 200,
  },
  pressed: {
    opacity: 0.7,
  },
  label: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
  },
});
