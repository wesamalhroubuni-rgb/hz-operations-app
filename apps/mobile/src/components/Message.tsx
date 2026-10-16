import { colors, fontSizes, radii, spacing } from '@ops/shared';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

type Tone = 'error' | 'notice' | 'success';

const TONE_COLORS: Record<Tone, string> = {
  error: colors.danger,
  notice: colors.warning,
  success: colors.success,
};

/**
 * A message above a form. It is announced by screen readers when it appears: an error
 * assertively, anything else politely.
 */
export function Message({
  tone,
  text,
  details = [],
  children,
}: Readonly<{ tone: Tone; text: string; details?: readonly string[]; children?: ReactNode }>) {
  const color = TONE_COLORS[tone];
  return (
    <View
      accessible={children === undefined}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      style={[styles.box, { borderLeftColor: color }]}
    >
      <Text style={[styles.text, { color }]}>{text}</Text>
      {details.map((detail) => (
        <Text key={detail} style={[styles.text, { color }]}>
          {`• ${detail}`}
        </Text>
      ))}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  text: {
    fontSize: fontSizes.sm,
    lineHeight: 20,
  },
});
