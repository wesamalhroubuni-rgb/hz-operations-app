import { newPasswordSchema, PASSWORD_MAX_LENGTH } from '../platform/auth.js';
import { AUTH_TEXT } from './auth-text.js';

// Validation of the sign-in and set-password forms, the same in the web and mobile apps. It only
// saves a round trip: the API validates everything again and is the authority.

export interface SignInFormValues {
  identifier: string;
  password: string;
}

export type SignInFormErrors = Partial<Record<keyof SignInFormValues, string>>;

/** Returns one message per field that is wrong; an empty object means the form can be sent. */
export function validateSignInForm(values: SignInFormValues): SignInFormErrors {
  const errors: SignInFormErrors = {};
  if (values.identifier.trim() === '') {
    errors.identifier = AUTH_TEXT.identifierRequired;
  }
  // The password is not trimmed and not checked against the policy: an old one may predate it.
  if (values.password === '') {
    errors.password = AUTH_TEXT.passwordRequired;
  }
  return errors;
}

export interface SetPasswordFormValues {
  code: string;
  password: string;
  confirmation: string;
}

export type SetPasswordFormErrors = Partial<Record<keyof SetPasswordFormValues, string>>;

/** The message for a new password that breaks the length policy, or null when it passes. */
export function newPasswordProblem(password: string): string | null {
  if (newPasswordSchema.safeParse(password).success) {
    return null;
  }
  return password.length > PASSWORD_MAX_LENGTH
    ? AUTH_TEXT.passwordTooLong
    : AUTH_TEXT.passwordTooShort;
}

export function validateSetPasswordForm(values: SetPasswordFormValues): SetPasswordFormErrors {
  const errors: SetPasswordFormErrors = {};
  if (values.code.trim() === '') {
    errors.code = AUTH_TEXT.codeRequired;
  }
  const problem = newPasswordProblem(values.password);
  if (problem !== null) {
    errors.password = problem;
  }
  if (values.confirmation === '') {
    errors.confirmation = AUTH_TEXT.confirmationRequired;
  } else if (values.confirmation !== values.password) {
    errors.confirmation = AUTH_TEXT.confirmationMismatch;
  }
  return errors;
}

/** True when a validation result has no message. */
export function isFormValid(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).every((message) => message === undefined);
}
