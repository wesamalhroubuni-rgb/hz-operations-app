import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CHECK_AGAIN_LABEL, describeHealth, type StatusTone } from '@ops/shared';
import { brand } from '../config/brand';
import { env, MISSING_API_URL_MESSAGE } from '../config/env';
import { useApiHealth } from '../hooks/useApiHealth';

const TONE_COLORS: Record<StatusTone, string> = {
  pending: colors.info,
  good: colors.success,
  warning: colors.warning,
  bad: colors.danger,
};

export function HomeScreen() {
  const { state, check } = useApiHealth();
  const view = describeHealth(state, MISSING_API_URL_MESSAGE);
  const toneColor = TONE_COLORS[view.tone];
  // A manual check is pointless without a URL or while the first answer is still on its way.
  const cannotCheck = state === null || state.result === null;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Image
            source={brand.logo.source}
            style={styles.logo}
            accessible
            accessibilityRole="image"
            accessibilityLabel={brand.logo.accessibilityLabel}
          />
          <Text style={styles.title} accessibilityRole="header">
            {brand.name}
          </Text>
          <Text style={styles.label}>{brand.appLabel}</Text>
          <View style={styles.rule} />
        </View>

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

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: cannotCheck }}
            disabled={cannotCheck}
            onPress={check}
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
              cannotCheck && styles.buttonDisabled,
            ]}
          >
            <Text style={[styles.buttonText, cannotCheck && styles.buttonTextDisabled]}>
              {CHECK_AGAIN_LABEL}
            </Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.poweredBy}>{brand.poweredBy}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.xl,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.xxl,
  },
  header: {
    alignItems: 'center',
  },
  logo: {
    width: 160,
    height: 160,
  },
  title: {
    marginTop: spacing.sm,
    fontSize: fontSizes.xxl,
    fontWeight: fontWeights.bold,
    letterSpacing: 1,
    color: colors.primary,
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
  button: {
    marginTop: spacing.sm,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
  },
  buttonPressed: {
    borderColor: colors.primaryHover,
    backgroundColor: colors.primaryHover,
  },
  buttonDisabled: {
    borderColor: colors.borderStrong,
    backgroundColor: 'transparent',
  },
  buttonText: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    color: colors.onPrimary,
  },
  buttonTextDisabled: {
    color: colors.textMuted,
  },
  poweredBy: {
    paddingVertical: spacing.lg,
    fontSize: fontSizes.xs,
    textAlign: 'center',
    color: colors.textMuted,
  },
});
