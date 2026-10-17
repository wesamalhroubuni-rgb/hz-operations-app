import { Ionicons } from '@expo/vector-icons';
import { colors, fontSizes, radii, spacing } from '@ops/shared';
import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { t } from '../i18n';
import { AppText } from './AppText';
import { Button } from './Button';
import { FieldShell } from './FieldShell';
import { iconSize, touch } from './sizes';

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
}

interface PickerFieldProps {
  label: string;
  /** The chosen value, or null for none. */
  value: string | null;
  options: readonly PickerOption[];
  onChange: (value: string | null) => void;
  /** Offers a "none" row (for optional fields) with this text. */
  noneLabel?: string;
  placeholder?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
}

const SEARCH_FROM = 8;

/**
 * A field that opens a full-screen list of large rows: easier with gloves than a native spinner,
 * readable at any text size, searchable when the list is long.
 */
export function PickerField({
  label,
  value,
  options,
  onChange,
  noneLabel,
  placeholder = t('logForm.chooseOption'),
  error,
  hint,
  required,
  disabled,
}: Readonly<PickerFieldProps>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value) ?? null;
  const shown = selected?.label ?? (value === null && noneLabel ? noneLabel : placeholder);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = needle
      ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle))
      : options;
    return noneLabel && !needle ? [{ value: '', label: noneLabel }, ...filtered] : filtered;
  }, [options, query, noneLabel]);

  function choose(next: string): void {
    onChange(next === '' ? null : next);
    setOpen(false);
    setQuery('');
  }

  return (
    <FieldShell label={label} error={error} hint={hint} required={required}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${shown}`}
        accessibilityHint={t('logForm.chooseOption')}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.control,
          error ? styles.controlInvalid : null,
          pressed && styles.pressed,
        ]}
      >
        <AppText variant={selected ? 'body' : 'secondary'} style={styles.value} numberOfLines={2}>
          {shown}
        </AppText>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modal}>
          <View style={styles.modalHeader}>
            <AppText variant="heading" style={styles.flex}>
              {label}
            </AppText>
            <Button variant="secondary" label={t('common.close')} onPress={() => setOpen(false)} />
          </View>
          {options.length >= SEARCH_FROM ? (
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('logForm.pickerSearch')}
              accessibilityLabel={t('logForm.pickerSearch')}
              placeholderTextColor={colors.textMuted}
              selectionColor={colors.primary}
              style={styles.search}
              autoCorrect={false}
            />
          ) : null}
          <FlatList
            data={rows}
            keyExtractor={(item) => item.value || 'none'}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            ListEmptyComponent={<AppText variant="secondary">{t('logForm.pickerEmpty')}</AppText>}
            renderItem={({ item }) => {
              const isSelected = (item.value === '' ? null : item.value) === value;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={item.label}
                  onPress={() => choose(item.value)}
                  style={({ pressed }) => [
                    styles.row,
                    isSelected && styles.rowSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.flex}>
                    <AppText variant="bodyStrong">{item.label}</AppText>
                    {'description' in item && item.description ? (
                      <AppText variant="muted">{item.description}</AppText>
                    ) : null}
                  </View>
                  {isSelected ? (
                    <Ionicons name="checkmark-circle" size={iconSize.lg} color={colors.primary} />
                  ) : null}
                </Pressable>
              );
            }}
          />
        </SafeAreaView>
      </Modal>
    </FieldShell>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  control: {
    minHeight: touch.comfortable,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  controlInvalid: {
    borderColor: colors.danger,
  },
  pressed: {
    borderColor: colors.primary,
  },
  value: {
    flex: 1,
  },
  modal: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  search: {
    minHeight: touch.comfortable,
    margin: spacing.lg,
    marginBottom: 0,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
    color: colors.textPrimary,
    fontSize: fontSizes.md,
  },
  list: {
    gap: spacing.sm,
    padding: spacing.lg,
  },
  row: {
    minHeight: touch.comfortable,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  rowSelected: {
    borderColor: colors.primary,
  },
});
