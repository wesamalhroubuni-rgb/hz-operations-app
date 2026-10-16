import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { Pressable, StyleSheet, Text } from 'react-native';

interface ButtonProps {
  label: string;
  onPress: () => void;
  /** `primary` is the filled gold button; `secondary` is outlined; `link` is text only. */
  variant?: 'primary' | 'secondary' | 'link';
  disabled?: boolean;
  /** Announced as busy to screen readers. The caller changes the label ("Signing in…"). */
  busy?: boolean;
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityHint,
}: Readonly<ButtonProps>) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole={variant === 'link' ? 'link' : 'button'}
      accessibilityState={{ disabled: inactive, busy }}
      accessibilityHint={accessibilityHint}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && pressedStyles[variant],
        inactive && variant !== 'link' && styles.inactive,
      ]}
    >
      <Text style={[styles.text, textStyles[variant], inactive && styles.textInactive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    // 48 dp: the minimum comfortable touch target.
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  primary: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  secondary: {
    borderColor: colors.borderStrong,
    backgroundColor: 'transparent',
  },
  link: {
    borderColor: 'transparent',
    backgroundColor: 'transparent',
  },
  inactive: {
    borderColor: colors.borderStrong,
    backgroundColor: 'transparent',
  },
  text: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    textAlign: 'center',
  },
  textInactive: {
    color: colors.textMuted,
  },
});

const pressedStyles = StyleSheet.create({
  primary: {
    borderColor: colors.primaryHover,
    backgroundColor: colors.primaryHover,
  },
  secondary: {
    borderColor: colors.primary,
  },
  link: {
    backgroundColor: colors.surfaceRaised,
  },
});

const textStyles = StyleSheet.create({
  primary: {
    color: colors.onPrimary,
  },
  secondary: {
    color: colors.textPrimary,
  },
  link: {
    color: colors.primary,
    textDecorationLine: 'underline',
  },
});
