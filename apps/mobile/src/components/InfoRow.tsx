import { colors, spacing } from '@ops/shared';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';

/** A label and its value, read together by screen readers. Hidden when there is no value. */
export function InfoRow({
  label,
  value,
}: Readonly<{ label: string; value: string | null | undefined }>) {
  if (!value) return null;
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="label">{label}</AppText>
      <AppText variant="body">{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing.xs / 2,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
});
