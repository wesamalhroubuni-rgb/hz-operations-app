import { describe, expect, it } from 'vitest';

import { ROLES } from '../domain/enums.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../platform/auth.js';
import {
  isFormValid,
  newPasswordProblem,
  validateSetPasswordForm,
  validateSignInForm,
} from './auth-forms.js';
import {
  AUTH_FAILURE_MESSAGES,
  AUTH_NOTICE_MESSAGES,
  AUTH_TEXT,
  NO_ROLE_LABEL,
  roleLabel,
} from './auth-text.js';

const GOOD = 'a'.repeat(PASSWORD_MIN_LENGTH);

describe('validateSignInForm', () => {
  it('accepts an identifier and a password', () => {
    const errors = validateSignInForm({ identifier: 'sam', password: 'x' });
    expect(errors).toEqual({});
    expect(isFormValid(errors)).toBe(true);
  });

  it('does not apply the new-password policy to an existing password', () => {
    expect(validateSignInForm({ identifier: 'sam', password: 'short' })).toEqual({});
  });

  it('names each empty field', () => {
    const errors = validateSignInForm({ identifier: '   ', password: '' });
    expect(errors).toEqual({
      identifier: AUTH_TEXT.identifierRequired,
      password: AUTH_TEXT.passwordRequired,
    });
    expect(isFormValid(errors)).toBe(false);
  });

  it('does not trim the password: spaces can be part of it', () => {
    expect(validateSignInForm({ identifier: 'sam', password: '   ' })).toEqual({});
  });
});

describe('newPasswordProblem', () => {
  it('accepts the minimum and the maximum length', () => {
    expect(newPasswordProblem(GOOD)).toBeNull();
    expect(newPasswordProblem('a'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it('refuses one character less and one more', () => {
    expect(newPasswordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(
      AUTH_TEXT.passwordTooShort,
    );
    expect(newPasswordProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe(AUTH_TEXT.passwordTooLong);
    expect(newPasswordProblem('')).toBe(AUTH_TEXT.passwordTooShort);
  });

  it('states the policy the schema enforces', () => {
    expect(AUTH_TEXT.passwordPolicy).toContain(String(PASSWORD_MIN_LENGTH));
    expect(AUTH_TEXT.passwordTooShort).toContain(String(PASSWORD_MIN_LENGTH));
  });
});

describe('validateSetPasswordForm', () => {
  it('accepts a code, a long enough password and the same password again', () => {
    expect(validateSetPasswordForm({ code: 'ABC', password: GOOD, confirmation: GOOD })).toEqual(
      {},
    );
  });

  it('names every problem at once', () => {
    expect(validateSetPasswordForm({ code: ' ', password: 'short', confirmation: '' })).toEqual({
      code: AUTH_TEXT.codeRequired,
      password: AUTH_TEXT.passwordTooShort,
      confirmation: AUTH_TEXT.confirmationRequired,
    });
  });

  it('refuses a confirmation that differs, even only by case or a space', () => {
    for (const confirmation of [GOOD.toUpperCase(), `${GOOD} `]) {
      expect(validateSetPasswordForm({ code: 'ABC', password: GOOD, confirmation })).toEqual({
        confirmation: AUTH_TEXT.confirmationMismatch,
      });
    }
  });
});

describe('roleLabel', () => {
  it('has a readable label for every role of the domain', () => {
    expect(ROLES.map((role) => roleLabel(role))).toEqual([
      'Worker',
      'Supervisor',
      'Manager',
      'Administrator',
    ]);
  });

  it('says so when the user has no role', () => {
    expect(roleLabel(null)).toBe(NO_ROLE_LABEL);
    expect(roleLabel(undefined)).toBe(NO_ROLE_LABEL);
    expect(roleLabel('')).toBe(NO_ROLE_LABEL);
  });

  it('shows a role it does not know rather than hiding it', () => {
    expect(roleLabel('site_auditor')).toBe('Site auditor');
  });
});

describe('wording', () => {
  it('has a message for every reason and notice, none of them empty', () => {
    for (const message of [
      ...Object.values(AUTH_FAILURE_MESSAGES),
      ...Object.values(AUTH_NOTICE_MESSAGES),
      ...Object.values(AUTH_TEXT),
    ]) {
      expect(message.trim()).not.toBe('');
    }
  });

  it('does not say whether an account exists or is locked for certain', () => {
    expect(AUTH_FAILURE_MESSAGES.invalid_credentials).not.toMatch(/no such|not found|unknown/i);
  });

  it('names no client and no builder', () => {
    const everything = JSON.stringify([AUTH_FAILURE_MESSAGES, AUTH_NOTICE_MESSAGES, AUTH_TEXT]);
    expect(everything).not.toMatch(/kaneri|\bHZ\b/i);
  });
});
