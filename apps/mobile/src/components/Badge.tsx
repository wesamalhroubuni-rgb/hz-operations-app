import { fontSizes, fontWeights, radii, spacing, type ThemeColors } from '@ops/shared';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'primary';

/** Text colour of a tone in a theme: every one passes AA as normal text on the surfaces. */
export function toneColor(colors: ThemeColors, tone: Tone): string {
  switch (tone) {
    case 'neutral':
      return colors.textSecondary;
    case 'info':
      return colors.info;
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'danger':
      return colors.danger;
    case 'primary':
      return colors.primary;
  }
}

/** A short status label in an outlined pill. Colour is never the only signal: it has text. */
export function Badge({ label, tone = 'neutral' }: Readonly<{ label: string; tone?: Tone }>) {
  const { colors } = useTheme();
  const color = toneColor(colors, tone);
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
