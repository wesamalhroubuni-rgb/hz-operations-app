import { newPasswordSchema, type ApiErrorDetail } from '@ops/shared';

/**
 * Policy for a NEW password, on top of the length rule both clients already apply
 * (`newPasswordSchema`): it must not be, or contain, something anyone who knows the person could
 * guess, and it must not be one of the passwords every attacker tries first.
 */

/** What is known about the person choosing the password. */
export interface PasswordContext {
  email?: string | null;
  phone?: string | null;
  username?: string | null;
  displayName?: string | null;
}

/**
 * Well-known passwords that are long enough to pass the length rule. Deliberately small: length
 * and the personal-data checks do most of the work.
 */
const WELL_KNOWN = new Set([
  'password123',
  'password1234',
  'password12345',
  'password123456',
  'passwordpassword',
  'mypassword123',
  'p@ssw0rd123',
  'p@ssword123',
  'passw0rd123',
  '1234567890',
  '12345678910',
  '123456789012',
  '0123456789',
  '0987654321',
  '9876543210',
  '1234512345',
  '1122334455',
  'qwertyuiop',
  'qwertyuiop123',
  'qwerty123456',
  'qwerty12345',
  '1q2w3e4r5t',
  '1q2w3e4r5t6y',
  'qazwsxedcrfv',
  '1qaz2wsx3edc',
  'zaq12wsxcde3',
  'asdfghjkl123',
  'abcdefghij',
  'abcdefghijk',
  'abcdef123456',
  'abc123abc123',
  'iloveyou123',
  'iloveyou1234',
  'letmein12345',
  'welcome123',
  'welcome1234',
  'welcome12345',
  'changeme123',
  'changeme1234',
  'administrator',
  'adminadmin',
  'admin123456',
  'admin12345',
  'football123',
  'baseball123',
  'superman123',
  'sunshine123',
  'princess123',
  'starwars123',
  'trustno1234',
  'monkey12345',
  'dragon12345',
  'master12345',
  'whatever123',
  'computer123',
  'internet123',
  'test1234567',
  'testtest123',
  'secret12345',
]);

/** Shorter personal values would refuse too many innocent passwords when found inside one. */
const MIN_CONTAINED_LENGTH = 4;

function personalValues(context: PasswordContext): string[] {
  const values = new Set<string>();
  const add = (value: string | null | undefined): void => {
    const normalized = value?.trim().toLowerCase();
    if (normalized) {
      values.add(normalized);
    }
  };

  add(context.email);
  add(context.email?.split('@')[0]);
  add(context.username);
  add(context.phone);
  add(context.phone?.replace(/\D/g, ''));
  add(context.displayName);
  add(context.displayName?.replace(/\s+/g, ''));
  for (const part of context.displayName?.split(/\s+/) ?? []) {
    add(part);
  }
  return [...values];
}

/**
 * The problems of a new password, as error details on the given path; empty when it is
 * acceptable. The messages never repeat the password.
 */
export function checkNewPassword(
  password: string,
  context: PasswordContext = {},
  path = 'password',
): ApiErrorDetail[] {
  const length = newPasswordSchema.safeParse(password);
  if (!length.success) {
    return length.error.issues.map((issue) => ({ path, message: issue.message }));
  }

  const lower = password.toLowerCase();
  if (new Set(lower).size <= 2) {
    return [{ path, message: 'must not be one or two characters repeated' }];
  }
  if (WELL_KNOWN.has(lower)) {
    return [{ path, message: 'is too common; choose something only you would think of' }];
  }
  for (const value of personalValues(context)) {
    if (lower === value || (value.length >= MIN_CONTAINED_LENGTH && lower.includes(value))) {
      return [{ path, message: 'must not contain your name, email, phone number or username' }];
    }
  }
  return [];
}
