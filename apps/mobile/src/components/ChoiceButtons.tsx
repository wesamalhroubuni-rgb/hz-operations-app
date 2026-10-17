import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FieldShell } from './FieldShell';
import { touch } from './sizes';

export interface Choice {
  value: string;
  label: string;
}

/**
 * A few choices as large buttons in a wrapping grid: one tap, no menu to open. For short lists
 * (log types most used first, a select field with a handful of options). Tapping the chosen one
 * again clears it when `clearable`.
 */
export function ChoiceButtons({
  label,
  choices,
  value,
  onChange,
  clearable = false,
  error,
  hint,
  required,
}: Readonly<{
  label: string;
  choices: readonly Choice[];
  value: string | null;
  onChange: (value: string | null) => void;
  clearable?: boolean;
  error?: string;
  hint?: string | null;
  required?: boolean;
}>) {
  return (
    <FieldShell label={label} error={error} hint={hint} required={required}>
      <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={choice.label}
              onPress={() => onChange(selected && clearable ? null : choice.value)}
              style={({ pressed }) => [
                styles.choice,
                error ? styles.invalid : null,
                selected && styles.selected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.text, selected && styles.textSelected]}>{choice.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </FieldShell>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  choice: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: touch.comfortable,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  invalid: {
    borderColor: colors.danger,
  },
  selected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  pressed: {
    borderColor: colors.primary,
  },
  text: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  textSelected: {
    color: colors.onPrimary,
  },
});
