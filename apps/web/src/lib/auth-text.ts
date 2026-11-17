import { AUTH_FAILURE_MESSAGES, AUTH_TEXT, type AuthActionFailure } from '@ops/shared';

import { t, type TranslationKey } from '@/i18n';

// The sign-in wording is shared with the phone (`@ops/shared`) and arrives here as English
// sentences (form validation, session failures). These helpers route it through the catalogue, so
// a translation replaces it. Same helpers as the phone's `src/i18n/authText.ts`.

const AUTH_KEYS = new Map<string, string>(
  Object.entries(AUTH_TEXT).map(([key, value]) => [value, key]),
);

/** A shared sign-in sentence (`AUTH_TEXT`), translated; unknown text is returned as it is. */
export function translateAuthText(message: string | undefined | null): string | undefined {
  if (message === undefined || message === null) return undefined;
  const key = AUTH_KEYS.get(message);
  return key ? t(`auth.${key}` as TranslationKey) : message;
}

/**
 * The message of a failed sign-in action, translated by its reason. A message the session manager
 * did not take from the shared wording (the app's own "API URL not configured") is shown as is.
 */
export function authFailureText(failure: Pick<AuthActionFailure, 'reason' | 'message'>): string {
  if (failure.message !== AUTH_FAILURE_MESSAGES[failure.reason]) return failure.message;
  return t(`authFailures.${failure.reason}`);
}
