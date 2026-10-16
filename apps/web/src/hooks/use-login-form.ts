'use client';

import { isFormValid, validateSignInForm, type SignInFormErrors } from '@ops/shared';
import { useRef, useState, type FormEvent } from 'react';

import { useAuth } from '@/components/auth-provider';

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
  const identifierRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const found = validateSignInForm({ identifier, password });
    setErrors(found);
    setFailure(null);
    if (!isFormValid(found)) {
      (found.identifier ? identifierRef : passwordRef).current?.focus();
      return;
    }

    setSubmitting(true);
    const result = await signIn(identifier, password);
    if (result.ok) {
      // Stay "submitting": the route guard is already replacing this page.
      return;
    }
    setSubmitting(false);
    setFailure(result.failure.message);
    // The password is the likeliest thing to retype. It is kept, so a typo can be corrected.
    passwordRef.current?.focus();
    passwordRef.current?.select();
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
