import { colors, fontSizes, fontWeights, spacing } from '@ops/shared';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';

/**
 * The label, hint and error around any form control. The error is announced when it appears.
 * The control itself carries the label for screen readers, so the visible label is not read
 * twice.
 */
export function FieldShell({
  label,
  hint,
  error,
  required,
  children,
}: Readonly<{
  label: string;
  hint?: string | null;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}>) {
  return (
    <View style={styles.field}>
      <Text style={styles.label} importantForAccessibility="no" accessibilityElementsHidden>
        {label}
        {required ? <Text style={styles.required}>{` · ${t('common.required')}`}</Text> : null}
      </Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    color: colors.textPrimary,
    textAlign: 'auto',
  },
  required: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.regular,
    color: colors.textMuted,
  },
  hint: {
    fontSize: fontSizes.sm,
    color: colors.textMuted,
    textAlign: 'auto',
  },
  error: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    color: colors.danger,
    textAlign: 'auto',
  },
});
