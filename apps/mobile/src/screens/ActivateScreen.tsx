import { AUTH_TEXT } from '@ops/shared';
import { useEffect } from 'react';
import { BackHandler } from 'react-native';

import { AuthScreenLayout } from '../components/AuthScreenLayout';
import { Button } from '../components/Button';
import { PasswordField, TextField } from '../components/FormField';
import { Message } from '../components/Message';
import { useActivateForm } from '../hooks/useActivateForm';

interface ActivateScreenProps {
  /** The password was set: go to the sign-in form and say so. */
  onDone: () => void;
  onBack: () => void;
}

/**
 * Activation and password reset: the one-time code from the administrator, and a new password
 * typed twice. The code is typed in; opening the app from an activation link is a later phase.
 */
export function ActivateScreen({ onDone, onBack }: Readonly<ActivateScreenProps>) {
  const form = useActivateForm(onDone);

  useEffect(() => {
    // Android's back button returns to the sign-in form instead of closing the app.
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  return (
    <AuthScreenLayout title={AUTH_TEXT.activateTitle} intro={AUTH_TEXT.activateIntro}>
      {form.failure !== null ? (
        <Message tone="error" text={form.failure.message} details={form.failure.details} />
      ) : null}

      <TextField
        label={AUTH_TEXT.codeLabel}
        value={form.code}
        onValueChange={form.setCode}
        error={form.errors.code}
        inputRef={form.codeRef}
        // Codes are upper-case letters and digits; the API accepts any case and ignores dashes.
        autoCapitalize="characters"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => form.passwordRef.current?.focus()}
        editable={!form.submitting}
      />
      <PasswordField
        label={AUTH_TEXT.newPasswordLabel}
        hint={AUTH_TEXT.passwordPolicy}
        value={form.password}
        onValueChange={form.setPassword}
        error={form.errors.password}
        inputRef={form.passwordRef}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => form.confirmationRef.current?.focus()}
        editable={!form.submitting}
      />
      <PasswordField
        label={AUTH_TEXT.confirmPasswordLabel}
        value={form.confirmation}
        onValueChange={form.setConfirmation}
        error={form.errors.confirmation}
        inputRef={form.confirmationRef}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        onSubmitEditing={() => void form.submit()}
        editable={!form.submitting}
      />
      <Button
        label={form.submitting ? AUTH_TEXT.settingPassword : AUTH_TEXT.setPassword}
        onPress={() => void form.submit()}
        busy={form.submitting}
      />
      <Button variant="link" label={AUTH_TEXT.backToSignIn} onPress={onBack} />
    </AuthScreenLayout>
  );
}
