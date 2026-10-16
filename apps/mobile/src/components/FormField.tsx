import { AUTH_TEXT, colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { useState, type ReactNode, type Ref } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

interface FieldProps extends Omit<TextInputProps, 'onChangeText' | 'value' | 'style'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Shown under the field and announced when it appears. */
  error?: string;
  /** A standing hint, such as the password policy. */
  hint?: string;
  inputRef?: Ref<TextInput>;
}

function FieldFrame({
  label,
  error,
  hint,
  children,
}: Readonly<Pick<FieldProps, 'label' | 'error' | 'hint'> & { children: ReactNode }>) {
  return (
    <View style={styles.field}>
      {/* The input carries the label for screen readers, so this text is not read twice. */}
      <Text style={styles.label} importantForAccessibility="no" accessibilityElementsHidden>
        {label}
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

/** A labelled text input with its hint and its error. */
export function TextField({
  label,
  value,
  onValueChange,
  error,
  hint,
  inputRef,
  ...input
}: Readonly<FieldProps>) {
  return (
    <FieldFrame label={label} error={error} hint={hint}>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        {...input}
        ref={inputRef}
        value={value}
        onChangeText={onValueChange}
        accessibilityLabel={label}
        accessibilityHint={hint}
        aria-invalid={error ? true : undefined}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.primary}
        cursorColor={colors.primary}
        style={[styles.input, error ? styles.inputInvalid : null]}
      />
    </FieldFrame>
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
    <FieldFrame label={label} error={error} hint={hint}>
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
          accessibilityLabel={`${
            visible ? AUTH_TEXT.hidePasswordLabel : AUTH_TEXT.showPasswordLabel
          }: ${label}`}
          onPress={() => setVisible((current) => !current)}
          style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed]}
        >
          <Text style={styles.toggleText}>
            {visible ? AUTH_TEXT.hidePassword : AUTH_TEXT.showPassword}
          </Text>
        </Pressable>
      </View>
    </FieldFrame>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    color: colors.textPrimary,
  },
  input: {
    minHeight: 48,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
    color: colors.textPrimary,
    fontSize: fontSizes.md,
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
    minWidth: 64,
    minHeight: 48,
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
  hint: {
    fontSize: fontSizes.sm,
    color: colors.textMuted,
  },
  error: {
    fontSize: fontSizes.sm,
    color: colors.danger,
  },
});
