import { Ionicons } from '@expo/vector-icons';
import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { iconSize, touch } from './sizes';

export type IconName = ComponentProps<typeof Ionicons>['name'];

interface ButtonProps {
  label: string;
  onPress: () => void;
  /** `primary` is the filled gold button; `secondary` is outlined; `link` is text only. */
  variant?: 'primary' | 'secondary' | 'link';
  /** `large` is the main action of a screen: taller, bigger text, easy with gloves. */
  size?: 'default' | 'large';
  icon?: IconName;
  disabled?: boolean;
  /** Announced as busy to screen readers. The caller changes the label ("Signing in…"). */
  busy?: boolean;
  accessibilityHint?: string;
  accessibilityLabel?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'default',
  icon,
  disabled = false,
  busy = false,
  accessibilityHint,
  accessibilityLabel,
}: Readonly<ButtonProps>) {
  const inactive = disabled || busy;
  const textColor = inactive
    ? colors.textMuted
    : variant === 'primary'
      ? colors.onPrimary
      : variant === 'link'
        ? colors.primary
        : colors.textPrimary;
  return (
    <Pressable
      accessibilityRole={variant === 'link' ? 'link' : 'button'}
      accessibilityState={{ disabled: inactive, busy }}
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={inactive}
      onPress={onPress}
      hitSlop={variant === 'link' ? spacing.sm : undefined}
      style={({ pressed }) => [
        styles.base,
        size === 'large' && styles.large,
        styles[variant],
        pressed && pressedStyles[variant],
        inactive && variant !== 'link' && styles.inactive,
      ]}
    >
      <View style={styles.content}>
        {busy ? (
          <ActivityIndicator color={textColor} size="small" />
        ) : icon ? (
          <Ionicons
            name={icon}
            size={size === 'large' ? iconSize.lg : iconSize.md}
            color={textColor}
          />
        ) : null}
        <Text
          style={[
            styles.text,
            size === 'large' && styles.textLarge,
            { color: textColor },
            variant === 'link' && styles.linkText,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: touch.comfortable,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  large: {
    minHeight: touch.primary,
    borderRadius: radii.lg,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  primary: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  secondary: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  link: {
    minHeight: touch.min,
    borderColor: 'transparent',
    backgroundColor: 'transparent',
  },
  inactive: {
    borderColor: colors.borderStrong,
    backgroundColor: 'transparent',
  },
  text: {
    flexShrink: 1,
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    textAlign: 'center',
  },
  textLarge: {
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.bold,
  },
  linkText: {
    textDecorationLine: 'underline',
  },
});

const pressedStyles = StyleSheet.create({
  primary: {
    borderColor: colors.primaryHover,
    backgroundColor: colors.primaryHover,
  },
  secondary: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceRaised,
  },
  link: {
    backgroundColor: colors.surfaceRaised,
  },
});
