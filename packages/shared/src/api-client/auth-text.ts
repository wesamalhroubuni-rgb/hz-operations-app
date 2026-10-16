import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../platform/auth.js';

// Every user-facing sentence of the sign-in, activation and sign-out flows, so the web and mobile
// apps say the same thing in the same state. No client name appears here: the apps add their brand.

/** Why a sign-in, sign-out or set-password action did not succeed. */
export type AuthFailureReason =
  /** A required field is empty. Caught before any request is made. */
  | 'missing_fields'
  /** Wrong identifier or password, or the account is locked, archived or not activated. */
  | 'invalid_credentials'
  /** HTTP 429. */
  | 'rate_limited'
  /** Nothing answered, or not in time. */
  | 'network'
  /** The one-time code is wrong, already used or expired. */
  | 'invalid_code'
  /** The new password does not meet the policy; `details` says how. */
  | 'weak_password'
  | 'unexpected';

/**
 * One message per reason. `invalid_credentials` is deliberately vague, like the API's answer: it
 * must not reveal whether the account exists or is locked.
 */
export const AUTH_FAILURE_MESSAGES: Record<AuthFailureReason, string> = {
  missing_fields: 'Enter your email, phone or username and your password.',
  invalid_credentials:
    'Those sign-in details are not correct, or the account is temporarily locked. Check them and try again.',
  rate_limited: 'Too many attempts. Try again later.',
  network: 'Could not reach the server. Check your connection and try again.',
  invalid_code:
    'That code is not valid or has expired. Check it, or ask your administrator for a new one.',
  weak_password: 'Choose a different password.',
  unexpected: 'Something went wrong. Try again.',
};

/** Why the app shows the sign-in form although the user did not just open it for the first time. */
export type AuthSessionNotice =
  /** The session ended on the server: expired, revoked, or the password was changed. */
  | 'session_expired'
  /** The session could not be checked because the server did not answer. */
  | 'unreachable'
  /** Signed out on this device, but the server could not be told. */
  | 'sign_out_unconfirmed';

export const AUTH_NOTICE_MESSAGES: Record<AuthSessionNotice, string> = {
  session_expired: 'Your session has ended. Sign in again.',
  unreachable: 'Could not reach the server to check your session.',
  sign_out_unconfirmed:
    'You are signed out on this device, but the server could not be reached, so the session may stay active until it expires. Sign in and sign out again when you are back online.',
};

export const AUTH_TEXT = {
  signInTitle: 'Sign in',
  identifierLabel: 'Email, phone or username',
  passwordLabel: 'Password',
  showPassword: 'Show',
  hidePassword: 'Hide',
  showPasswordLabel: 'Show password',
  hidePasswordLabel: 'Hide password',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  haveCode: 'I have an activation code',
  retry: 'Try again',

  activateTitle: 'Set your password',
  activateIntro:
    'Enter the code your administrator gave you and choose a password. A password reset code works here too.',
  codeLabel: 'Activation or reset code',
  newPasswordLabel: 'New password',
  confirmPasswordLabel: 'Confirm new password',
  passwordPolicy: `At least ${PASSWORD_MIN_LENGTH} characters. A long phrase you can remember works well.`,
  setPassword: 'Set password',
  settingPassword: 'Saving…',
  backToSignIn: 'Back to sign in',
  passwordSet: 'Your password is set. Sign in with it now.',

  checkingSession: 'Checking your session…',
  signedInAs: 'Signed in as',
  signOut: 'Sign out',
  signOutEverywhere: 'Sign out everywhere',
  signingOut: 'Signing out…',
  signOutEverywhereHint: 'Ends your sessions on every device, including this one.',

  identifierRequired: 'Enter your email, phone or username.',
  passwordRequired: 'Enter your password.',
  codeRequired: 'Enter the code.',
  passwordTooShort: `The password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  passwordTooLong: `The password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
  confirmationRequired: 'Type the new password again.',
  confirmationMismatch: 'The two passwords do not match.',
} as const;

const ROLE_LABELS: Record<string, string> = {
  worker: 'Worker',
  supervisor: 'Supervisor',
  manager: 'Manager',
  admin: 'Administrator',
};

export const NO_ROLE_LABEL = 'No role assigned';

/**
 * A readable label for a role as the API names it (`authUser.role` is the user's highest role,
 * or null without an active membership). A role this build does not know is shown as sent, with a
 * capital letter, instead of being hidden.
 */
export function roleLabel(role: string | null | undefined): string {
  if (!role) {
    return NO_ROLE_LABEL;
  }
  const known = ROLE_LABELS[role];
  if (known) {
    return known;
  }
  const words = role.replace(/_/g, ' ').trim();
  return words === '' ? NO_ROLE_LABEL : words.charAt(0).toUpperCase() + words.slice(1);
}
