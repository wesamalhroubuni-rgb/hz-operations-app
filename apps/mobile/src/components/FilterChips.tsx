import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { touch } from './sizes';

export interface FilterOption<Value extends string> {
  value: Value;
  label: string;
  count?: number;
  accessibilityLabel?: string;
}

/**
 * A row of large, mutually exclusive filter buttons. It scrolls sideways when the labels do not
 * fit (large text, long translations) instead of shrinking the targets.
 */
export function FilterChips<Value extends string>({
  options,
  value,
  onChange,
}: Readonly<{
  options: readonly FilterOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
}>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroller}
      contentContainerStyle={styles.row}
      accessibilityRole="tablist"
    >
      {options.map((option) => {
        const selected = option.value === value;
        const text =
          option.count === undefined ? option.label : `${option.label} · ${option.count}`;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.accessibilityLabel ?? text}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.chip,
              selected && styles.selected,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.text, selected && styles.textSelected]}>{text}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: {
    flexGrow: 0,
  },
  row: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chip: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
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
  },
  textSelected: {
    color: colors.onPrimary,
  },
});
