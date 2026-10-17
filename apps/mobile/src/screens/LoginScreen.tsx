import { useAuth } from '../auth/AuthProvider';
import { AuthScreenLayout } from '../components/AuthScreenLayout';
import { Button } from '../components/Button';
import { PasswordField, TextField } from '../components/FormField';
import { Message } from '../components/Message';
import { useLoginForm } from '../hooks/useLoginForm';
import { t } from '../i18n';
import type { SignedOutScreenProps } from '../navigation/types';

export function LoginScreen({ route, navigation }: Readonly<SignedOutScreenProps<'Login'>>) {
  const { state, retry } = useAuth();
  const form = useLoginForm();
  const notice = state.status === 'signedOut' ? state.notice : null;
  const passwordSet = route.params?.passwordSet === true;

  return (
    <AuthScreenLayout title={t('auth.signInTitle')}>
      {passwordSet && form.failure === null ? (
        <Message tone="success" text={t('auth.passwordSet')} />
      ) : null}

      {notice !== null && form.failure === null ? (
        <Message tone="notice" text={t(`authNotices.${notice}`)}>
          {notice === 'unreachable' ? (
            <Button variant="secondary" label={t('auth.retry')} onPress={retry} />
          ) : undefined}
        </Message>
      ) : null}

      {form.failure !== null ? <Message tone="error" text={form.failure} /> : null}

      <TextField
        label={t('auth.identifierLabel')}
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
        label={t('auth.passwordLabel')}
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
        size="large"
        label={form.submitting ? t('auth.signingIn') : t('auth.signIn')}
        onPress={() => void form.submit()}
        busy={form.submitting}
      />
      <Button
        variant="link"
        label={t('auth.haveCode')}
        onPress={() => navigation.navigate('Activate')}
      />
    </AuthScreenLayout>
  );
}
