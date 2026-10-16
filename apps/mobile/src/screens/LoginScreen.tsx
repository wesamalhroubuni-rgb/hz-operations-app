import { AUTH_NOTICE_MESSAGES, AUTH_TEXT, type AuthSessionNotice } from '@ops/shared';

import { AuthScreenLayout } from '../components/AuthScreenLayout';
import { Button } from '../components/Button';
import { PasswordField, TextField } from '../components/FormField';
import { Message } from '../components/Message';
import { useLoginForm } from '../hooks/useLoginForm';

interface LoginScreenProps {
  /** Why the form is shown although the user was signed in before, if that is the case. */
  notice: AuthSessionNotice | null;
  /** The user has just set a password on the activation screen. */
  passwordSet: boolean;
  onRetry: () => void;
  onHaveCode: () => void;
}

export function LoginScreen({
  notice,
  passwordSet,
  onRetry,
  onHaveCode,
}: Readonly<LoginScreenProps>) {
  const form = useLoginForm();

  return (
    <AuthScreenLayout title={AUTH_TEXT.signInTitle}>
      {passwordSet && form.failure === null ? (
        <Message tone="success" text={AUTH_TEXT.passwordSet} />
      ) : null}

      {notice !== null && form.failure === null ? (
        <Message tone="notice" text={AUTH_NOTICE_MESSAGES[notice]}>
          {notice === 'unreachable' ? (
            <Button variant="secondary" label={AUTH_TEXT.retry} onPress={onRetry} />
          ) : undefined}
        </Message>
      ) : null}

      {form.failure !== null ? <Message tone="error" text={form.failure} /> : null}

      <TextField
        label={AUTH_TEXT.identifierLabel}
        value={form.identifier}
        onValueChange={form.setIdentifier}
        error={form.errors.identifier}
        inputRef={form.identifierRef}
        // The email keyboard has letters, digits, "@" and "." within reach: it suits an email, a
        // phone number and a username alike.
        keyboardType="email-address"
        autoComplete="username"
        textContentType="username"
        importantForAutofill="yes"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => form.passwordRef.current?.focus()}
        editable={!form.submitting}
      />
      <PasswordField
        label={AUTH_TEXT.passwordLabel}
        value={form.password}
        onValueChange={form.setPassword}
        error={form.errors.password}
        inputRef={form.passwordRef}
        autoComplete="current-password"
        textContentType="password"
        importantForAutofill="yes"
        returnKeyType="go"
        onSubmitEditing={() => void form.submit()}
        editable={!form.submitting}
      />
      <Button
        label={form.submitting ? AUTH_TEXT.signingIn : AUTH_TEXT.signIn}
        onPress={() => void form.submit()}
        busy={form.submitting}
      />
      <Button variant="link" label={AUTH_TEXT.haveCode} onPress={onHaveCode} />
    </AuthScreenLayout>
  );
}
