import { colors, fontSizes, radii, spacing } from '@ops/shared';
import { useState, type Ref } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { t } from '../i18n';
import { FieldShell } from './FieldShell';
import { touch } from './sizes';

interface FieldProps extends Omit<TextInputProps, 'onChangeText' | 'value' | 'style'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Shown under the field and announced when it appears. */
  error?: string;
  /** A standing hint, such as the password policy. */
  hint?: string;
  required?: boolean;
  inputRef?: Ref<TextInput>;
}

/** A labelled text input with its hint and its error. */
export function TextField({
  label,
  value,
  onValueChange,
  error,
  hint,
  required,
  inputRef,
  multiline,
  ...input
}: Readonly<FieldProps>) {
  return (
    <FieldShell label={label} error={error} hint={hint} required={required}>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        {...input}
        multiline={multiline}
        ref={inputRef}
        value={value}
        onChangeText={onValueChange}
        accessibilityLabel={label}
        accessibilityHint={hint}
        aria-invalid={error ? true : undefined}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.primary}
        cursorColor={colors.primary}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={[styles.input, multiline && styles.multiline, error ? styles.inputInvalid : null]}
      />
    </FieldShell>
  );
}

/** A password input with a button that shows or hides what was typed. */
export function PasswordField({
  label,
  value,
  onValueChange,
  error,
  hint,
  inputRef,
  ...input
}: Readonly<FieldProps>) {
  const [visible, setVisible] = useState(false);
  return (
    <FieldShell label={label} error={error} hint={hint}>
      <View style={styles.passwordRow}>
        <TextInput
          {...input}
          ref={inputRef}
          value={value}
          onChangeText={onValueChange}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel={label}
          accessibilityHint={hint}
          aria-invalid={error ? true : undefined}
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primary}
          cursorColor={colors.primary}
          style={[styles.input, styles.passwordInput, error ? styles.inputInvalid : null]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${visible ? t('auth.hidePasswordLabel') : t('auth.showPasswordLabel')}: ${label}`}
          onPress={() => setVisible((current) => !current)}
          style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed]}
        >
          <Text style={styles.toggleText}>
            {visible ? t('auth.hidePassword') : t('auth.showPassword')}
          </Text>
        </Pressable>
      </View>
    </FieldShell>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: touch.comfortable,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
    color: colors.textPrimary,
    fontSize: fontSizes.md,
    textAlign: 'auto',
  },
  multiline: {
    minHeight: touch.primary * 2,
    paddingTop: spacing.md,
  },
  inputInvalid: {
    borderColor: colors.danger,
  },
  passwordRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  passwordInput: {
    flex: 1,
  },
  toggle: {
    minWidth: touch.primary,
    minHeight: touch.comfortable,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
  },
  togglePressed: {
    borderColor: colors.primary,
  },
  toggleText: {
    fontSize: fontSizes.sm,
    color: colors.textPrimary,
  },
});
