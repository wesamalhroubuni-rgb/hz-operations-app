import {
  isFormValid,
  validateSetPasswordForm,
  type AuthActionFailure,
  type SetPasswordFormErrors,
} from '@ops/shared';
import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';

import { useAuth } from '../auth/AuthProvider';

/** State of the activation (and password reset) form. `onDone` runs once the password is set. */
export function useActivateForm(onDone: () => void) {
  const { setPassword: savePassword } = useAuth();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<SetPasswordFormErrors>({});
  const [failure, setFailure] = useState<AuthActionFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const codeRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmationRef = useRef<TextInput>(null);

  async function submit(): Promise<void> {
    if (submitting) {
      return;
    }
    const found = validateSetPasswordForm({ code, password, confirmation });
    setErrors(found);
    setFailure(null);
    if (!isFormValid(found)) {
      const first = found.code ? codeRef : found.password ? passwordRef : confirmationRef;
      first.current?.focus();
      return;
    }

    setSubmitting(true);
    const result = await savePassword(code, password);
    if (result.ok) {
      onDone();
      return;
    }
    setSubmitting(false);
    setFailure(result.failure);
  }

  return {
    code,
    setCode,
    password,
    setPassword,
    confirmation,
    setConfirmation,
    errors,
    failure,
    submitting,
    codeRef,
    passwordRef,
    confirmationRef,
    submit,
  };
}
