import { isFormValid, validateSignInForm, type SignInFormErrors } from '@ops/shared';
import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { authFailureText, translateAuthErrors } from '../i18n/authText';

/**
 * State of the sign-in form. Validation and the meaning of failures live in `@ops/shared`; this
 * hook holds what was typed, runs the action, and moves the focus to where the problem is.
 */
export function useLoginForm() {
  const { signIn } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<SignInFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const identifierRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  async function submit(): Promise<void> {
    if (submitting) {
      return;
    }
    const found = validateSignInForm({ identifier, password });
    setErrors(translateAuthErrors(found));
    setFailure(null);
    if (!isFormValid(found)) {
      (found.identifier ? identifierRef : passwordRef).current?.focus();
      return;
    }

    setSubmitting(true);
    const result = await signIn(identifier, password);
    if (result.ok) {
      // Stay "submitting": the app is already switching to the home screen.
      return;
    }
    setSubmitting(false);
    setFailure(authFailureText(result.failure));
  }

  return {
    identifier,
    setIdentifier,
    password,
    setPassword,
    errors,
    failure,
    submitting,
    identifierRef,
    passwordRef,
    submit,
  };
}
