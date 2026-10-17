import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { StyleSheet, Text, View } from 'react-native';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'primary';

/** Text colours of each tone: every one passes AA as normal text on the surfaces. */
export const TONE_COLORS: Record<Tone, string> = {
  neutral: colors.textSecondary,
  info: colors.info,
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
  primary: colors.primary,
};

/** A short status label in an outlined pill. Colour is never the only signal: it has text. */
export function Badge({ label, tone = 'neutral' }: Readonly<{ label: string; tone?: Tone }>) {
  const color = TONE_COLORS[tone];
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.text, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
    borderWidth: 1,
    borderRadius: radii.pill,
  },
  text: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
  },
});
