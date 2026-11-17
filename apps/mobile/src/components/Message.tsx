import { fontSizes, radii, spacing, type ThemeColors } from '@ops/shared';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { makeStyles, useTheme } from '../theme';

type Tone = 'error' | 'notice' | 'success';

function toneColor(colors: ThemeColors, tone: Tone): string {
  return tone === 'error' ? colors.danger : tone === 'notice' ? colors.warning : colors.success;
}

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
  const styles = useStyles();
  const { colors } = useTheme();
  const color = toneColor(colors, tone);
  return (
    <View
      accessible={children === undefined}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      style={[styles.box, { borderStartColor: color }]}
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

const useStyles = makeStyles((colors) => ({
  box: {
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderStartWidth: 3,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  text: {
    fontSize: fontSizes.sm,
    lineHeight: 20,
  },
}));
