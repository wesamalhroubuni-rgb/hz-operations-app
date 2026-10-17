import { AuthScreenLayout } from '../components/AuthScreenLayout';
import { Button } from '../components/Button';
import { PasswordField, TextField } from '../components/FormField';
import { Message } from '../components/Message';
import { useActivateForm } from '../hooks/useActivateForm';
import { t } from '../i18n';
import { authFailureText } from '../i18n/authText';
import type { SignedOutScreenProps } from '../navigation/types';

/**
 * Activation and password reset: the one-time code from the administrator, and a new password
 * typed twice. The code is typed in; opening the app from an activation link is a later phase.
 * The stack's back gesture and Android's back button return to sign-in.
 */
export function ActivateScreen({ navigation }: Readonly<SignedOutScreenProps<'Activate'>>) {
  const form = useActivateForm(() => navigation.popTo('Login', { passwordSet: true }));

  return (
    <AuthScreenLayout title={t('auth.activateTitle')} intro={t('auth.activateIntro')}>
      {form.failure !== null ? (
        <Message tone="error" text={authFailureText(form.failure)} details={form.failure.details} />
      ) : null}

      <TextField
        label={t('auth.codeLabel')}
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
        label={t('auth.newPasswordLabel')}
        hint={t('auth.passwordPolicy')}
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
        label={t('auth.confirmPasswordLabel')}
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
        size="large"
        label={form.submitting ? t('auth.settingPassword') : t('auth.setPassword')}
        onPress={() => void form.submit()}
        busy={form.submitting}
      />
      <Button variant="link" label={t('auth.backToSignIn')} onPress={() => navigation.goBack()} />
    </AuthScreenLayout>
  );
}
