import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { colors, radii, spacing } from '@ops/shared';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatDate, formatDateTime, localeTag, t } from '../i18n';
import { AppText } from './AppText';
import { Button } from './Button';
import { FieldShell } from './FieldShell';
import { touch } from './sizes';

interface DateTimeFieldProps {
  label: string;
  /** `datetime` for "when did it happen", `date` for a custom date field. */
  mode: 'datetime' | 'date';
  value: Date | null;
  onChange: (value: Date | null) => void;
  /** Shown when there is no value ("Now" for the log time, "Not set" for a date field). */
  emptyText: string;
  /** The button that sets the value back to empty ("Use now" / "Clear"). */
  clearLabel?: string;
  maximumDate?: Date;
  error?: string;
  hint?: string | null;
  required?: boolean;
}

/**
 * A date (or date and time) with the platform's own picker, which Expo Go includes: Android's
 * dialogs (date, then time), and on iOS an inline calendar in a sheet with "Done".
 */
export function DateTimeField({
  label,
  mode,
  value,
  onChange,
  emptyText,
  clearLabel,
  maximumDate,
  error,
  hint,
  required,
}: Readonly<DateTimeFieldProps>) {
  const [iosOpen, setIosOpen] = useState(false);
  const [iosValue, setIosValue] = useState<Date>(value ?? new Date());
  const shown =
    value === null ? emptyText : mode === 'date' ? formatDate(value) : formatDateTime(value);

  function openAndroid(): void {
    const start = value ?? new Date();
    DateTimePickerAndroid.open({
      value: start,
      mode: 'date',
      maximumDate,
      onValueChange: (_event, date) => {
        if (mode === 'date') {
          onChange(date);
          return;
        }
        DateTimePickerAndroid.open({
          value: date,
          mode: 'time',
          is24Hour: true,
          onValueChange: (_timeEvent, time) => {
            const combined = new Date(date.getTime());
            combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
            onChange(maximumDate && combined > maximumDate ? maximumDate : combined);
          },
        });
      },
    });
  }

  function open(): void {
    if (Platform.OS === 'android') {
      openAndroid();
    } else {
      setIosValue(value ?? new Date());
      setIosOpen(true);
    }
  }

  return (
    <FieldShell label={label} error={error} hint={hint} required={required}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${shown}`}
          accessibilityHint={t('common.change')}
          onPress={open}
          style={({ pressed }) => [
            styles.control,
            error ? styles.invalid : null,
            pressed && styles.pressed,
          ]}
        >
          <AppText variant="body">{shown}</AppText>
          <AppText variant="label" style={styles.change}>
            {t('common.change')}
          </AppText>
        </Pressable>
        {clearLabel && value !== null ? (
          <Button variant="secondary" label={clearLabel} onPress={() => onChange(null)} />
        ) : null}
      </View>

      {Platform.OS === 'ios' ? (
        <Modal
          visible={iosOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setIosOpen(false)}
        >
          <View style={styles.backdrop}>
            <SafeAreaView edges={['bottom']} style={styles.sheet}>
              <AppText variant="heading">{label}</AppText>
              <DateTimePicker
                value={iosValue}
                mode={mode}
                display="inline"
                themeVariant="dark"
                accentColor={colors.primary}
                locale={localeTag}
                maximumDate={maximumDate}
                onValueChange={(_event, date) => setIosValue(date)}
              />
              <Button
                size="large"
                label={t('common.save')}
                onPress={() => {
                  onChange(iosValue);
                  setIosOpen(false);
                }}
              />
              <Button
                variant="secondary"
                label={t('common.cancel')}
                onPress={() => setIosOpen(false)}
              />
            </SafeAreaView>
          </View>
        </Modal>
      ) : null}
    </FieldShell>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  control: {
    flex: 1,
    minHeight: touch.comfortable,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  invalid: {
    borderColor: colors.danger,
  },
  pressed: {
    borderColor: colors.primary,
  },
  change: {
    color: colors.primary,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.background,
  },
  sheet: {
    gap: spacing.md,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    backgroundColor: colors.surface,
  },
});
