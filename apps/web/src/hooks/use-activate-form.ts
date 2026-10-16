'use client';

import {
  isFormValid,
  validateSetPasswordForm,
  type AuthActionFailure,
  type SetPasswordFormErrors,
} from '@ops/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useAuth } from '@/components/auth-provider';
import { ACTIVATE_PATH, LOGIN_PATH, NOTICE_PARAM, PASSWORD_SET_NOTICE } from '@/lib/auth/routes';

/**
 * State of the activation (and password reset) form. `initialCode` is the `?code=` of the link
 * the user followed, if any.
 */
export function useActivateForm(initialCode: string) {
  const { setPassword: savePassword } = useAuth();
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<SetPasswordFormErrors>({});
  const [failure, setFailure] = useState<AuthActionFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The code is a credential until it is used. Take it out of the address bar straight away,
    // so it does not stay in the browser history, in a bookmark or in a screenshot of the page.
    if (window.location.search !== '') {
      window.history.replaceState(window.history.state, '', ACTIVATE_PATH);
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
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
      router.replace(`${LOGIN_PATH}?${NOTICE_PARAM}=${PASSWORD_SET_NOTICE}`);
      return;
    }
    setSubmitting(false);
    setFailure(result.failure);
    (result.failure.reason === 'invalid_code' ? codeRef : passwordRef).current?.focus();
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
