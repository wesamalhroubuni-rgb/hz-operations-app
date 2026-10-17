import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { FieldShell } from './FieldShell';
import { touch } from './sizes';

/**
 * A yes/no question as two large buttons instead of a small switch: easier with gloves, and it
 * can stay unanswered (null), which a required field needs. Tapping the chosen answer again
 * clears it.
 */
export function YesNoField({
  label,
  value,
  onChange,
  error,
  hint,
  required,
}: Readonly<{
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  error?: string;
  hint?: string | null;
  required?: boolean;
}>) {
  const choices: { answer: boolean; text: string }[] = [
    { answer: true, text: t('common.yes') },
    { answer: false, text: t('common.no') },
  ];
  return (
    <FieldShell label={label} error={error} hint={hint} required={required}>
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {choices.map(({ answer, text }) => {
          const selected = value === answer;
          return (
            <Pressable
              key={text}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${label}: ${text}`}
              onPress={() => onChange(selected ? null : answer)}
              style={({ pressed }) => [
                styles.choice,
                error ? styles.invalid : null,
                selected && styles.selected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.text, selected && styles.textSelected]}>{text}</Text>
            </Pressable>
          );
        })}
      </View>
    </FieldShell>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  choice: {
    flex: 1,
    minHeight: touch.comfortable,
    alignItems: 'center',
    justifyContent: 'center',
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
  },
  textSelected: {
    color: colors.onPrimary,
  },
});
