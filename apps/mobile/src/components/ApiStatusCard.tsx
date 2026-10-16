import {
  CHECK_AGAIN_LABEL,
  colors,
  describeHealth,
  fontSizes,
  fontWeights,
  radii,
  spacing,
  type StatusTone,
} from '@ops/shared';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { env, MISSING_API_URL_MESSAGE } from '../config/env';
import { useApiHealth } from '../hooks/useApiHealth';
import { Button } from './Button';

const TONE_COLORS: Record<StatusTone, string> = {
  pending: colors.info,
  good: colors.success,
  warning: colors.warning,
  bad: colors.danger,
};

/** Whether the API answers, with the same states and wording as the web dashboard. */
export function ApiStatusCard() {
  const { state, check } = useApiHealth();
  const view = describeHealth(state, MISSING_API_URL_MESSAGE);
  const toneColor = TONE_COLORS[view.tone];
  // A manual check is pointless without a URL or while the first answer is still on its way.
  const cannotCheck = state === null || state.result === null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardHeading}>API status</Text>
      <View accessible accessibilityLiveRegion="polite" style={styles.status}>
        <View style={styles.statusRow}>
          {view.busy ? (
            <ActivityIndicator color={toneColor} size="small" />
          ) : (
            <View style={[styles.dot, { backgroundColor: toneColor }]} />
          )}
          <Text style={styles.statusTitle}>{view.title}</Text>
        </View>
        <Text style={styles.detail}>{view.detail}</Text>
      </View>
      {env.apiUrl ? <Text style={styles.url}>{`${env.apiUrl}/health`}</Text> : null}
      <Button label={CHECK_AGAIN_LABEL} onPress={check} disabled={cannotCheck} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  cardHeading: {
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.semibold,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  status: {
    gap: spacing.xs,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 24,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  statusTitle: {
    flexShrink: 1,
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.semibold,
    color: colors.textPrimary,
  },
  detail: {
    fontSize: fontSizes.sm,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  url: {
    fontSize: fontSizes.xs,
    color: colors.textMuted,
  },
});
