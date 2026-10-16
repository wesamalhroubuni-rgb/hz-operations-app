/**
 * Login identifiers (pure functions, no dependencies).
 *
 * A person signs in with an email, a phone number or a username. The three are stored and looked
 * up in one normal form, and what was typed tells which of the three it is:
 * - it contains `@`                                                   -> email
 * - only digits, `+`, spaces, dashes, dots-free parentheses, with at
 *   least 6 digits                                                    -> phone
 * - anything else                                                     -> username
 *
 * A username is 3 to 32 characters of `a-z 0-9 . _ -` and must contain a letter, so it can never
 * look like a phone number, and it cannot contain `@`, so it can never look like an email. The
 * three namespaces therefore cannot collide.
 *
 * Whoever stores a user (the host application's user management) must store the identifiers with
 * the same normalisers, or the lookup at sign-in will not find them.
 */

export type IdentifierKind = 'email' | 'phone' | 'username';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const PHONE_MIN_DIGITS = 6;
export const PHONE_MAX_DIGITS = 15;

const PHONE_INPUT = /^[+\d\s\-()]+$/;
const USERNAME = /^[a-z0-9._-]+$/;

/** Lower-case, trimmed. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Digits with an optional leading `+`; spaces, dashes and parentheses removed. */
export function normalizePhone(value: string): string {
  // Separators first, so "(+90) 532 ..." keeps its "+" exactly like the shared schema does.
  const compact = value.trim().replace(/[\s\-()]/g, '');
  const digits = compact.replace(/\D/g, '');
  return compact.startsWith('+') ? `+${digits}` : digits;
}

/** Lower-case, trimmed. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** True for something that has the shape of an email address (one `@`, text on both sides). */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value)) && value.trim().length <= 320;
}

/** True for a phone number as typed: phone characters only, 6 to 15 digits, `+` only in front. */
export function isValidPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!PHONE_INPUT.test(trimmed) || trimmed.indexOf('+') > 0) {
    return false;
  }
  const digits = trimmed.replace(/\D/g, '').length;
  return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
}

/** True for a username: 3 to 32 of `a-z 0-9 . _ -` (after lower-casing), with a letter. */
export function isValidUsername(value: string): boolean {
  const normalized = normalizeUsername(value);
  return (
    normalized.length >= USERNAME_MIN_LENGTH &&
    normalized.length <= USERNAME_MAX_LENGTH &&
    USERNAME.test(normalized) &&
    /[a-z]/.test(normalized)
  );
}

/** Which identifier a typed value is. See the rules at the top of this file. */
export function inferIdentifierKind(value: string): IdentifierKind {
  const trimmed = value.trim();
  if (trimmed.includes('@')) {
    return 'email';
  }
  if (PHONE_INPUT.test(trimmed) && trimmed.replace(/\D/g, '').length >= PHONE_MIN_DIGITS) {
    return 'phone';
  }
  return 'username';
}

export interface LoginIdentifier {
  kind: IdentifierKind;
  /** The normal form, as stored. */
  value: string;
}

export function normalizeIdentifier(kind: IdentifierKind, value: string): string {
  switch (kind) {
    case 'email':
      return normalizeEmail(value);
    case 'phone':
      return normalizePhone(value);
    case 'username':
      return normalizeUsername(value);
  }
}

/** What a person typed at sign-in, as the kind of identifier and its stored form. */
export function parseLoginIdentifier(value: string): LoginIdentifier {
  const kind = inferIdentifierKind(value);
  return { kind, value: normalizeIdentifier(kind, value) };
}
