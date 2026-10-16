import { logLevelsFrom, validateEnv, weakSecretReason } from './env';

// Example values only: none of these is a real credential or secret.
const STRONG_SECRET = 'kT9vB2xQ7mLr4ZpW8nYc3HdF6sJg1AeU5oXi0NqVbM';
const PLACEHOLDER_SECRET = 'dev_only_placeholder_change_me_before_any_real_use';

// A complete, valid environment without NODE_ENV.
const BASE = {
  DATABASE_URL: 'postgresql://user:example@localhost:5432/example_db?schema=public',
  DATABASE_CONNECT_TIMEOUT_MS: '5000',
  API_HOST: '0.0.0.0',
  API_PORT: '3001',
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:3002',
  LOG_LEVEL: 'log',
  AUTH_ACCESS_TOKEN_SECRET: STRONG_SECRET,
  WEB_APP_URL: 'https://app.example.com/',
};

const REQUIRED = Object.keys(BASE);

function messageOf(raw: Record<string, unknown>): string {
  try {
    validateEnv(raw);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('validateEnv', () => {
  describe('NODE_ENV', () => {
    it('defaults to production when it is not set', () => {
      expect(validateEnv({ ...BASE }).NODE_ENV).toBe('production');
    });

    it.each([['Development'], ['dev'], ['staging'], [''], [' development']])(
      'refuses an unknown NODE_ENV (%p)',
      (nodeEnv) => {
        expect(messageOf({ ...BASE, NODE_ENV: nodeEnv })).toContain(
          'NODE_ENV: must be one of: development, test, production',
        );
      },
    );
  });

  describe('the token signing secret', () => {
    it.each([['development'], ['test'], ['production'], [undefined]])(
      'is required when NODE_ENV is %p',
      (nodeEnv) => {
        const { AUTH_ACCESS_TOKEN_SECRET: _omitted, ...rest } = BASE;
        expect(messageOf({ ...rest, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) })).toContain(
          '- AUTH_ACCESS_TOKEN_SECRET: is required',
        );
      },
    );

    it.each([['development'], ['production']])(
      'must be at least 32 characters when NODE_ENV is %s',
      (nodeEnv) => {
        const message = messageOf({
          ...BASE,
          NODE_ENV: nodeEnv,
          AUTH_ACCESS_TOKEN_SECRET: 'kT9vB2xQ7mLr4ZpW8nYc3HdF6sJg1Ae',
        });
        expect(message).toContain('- AUTH_ACCESS_TOKEN_SECRET: must be at least 32 characters');
      },
    );

    it('accepts the placeholder of .env.example in development and test', () => {
      for (const nodeEnv of ['development', 'test']) {
        const env = validateEnv({
          ...BASE,
          NODE_ENV: nodeEnv,
          AUTH_ACCESS_TOKEN_SECRET: PLACEHOLDER_SECRET,
        });
        expect(env.AUTH_ACCESS_TOKEN_SECRET).toBe(PLACEHOLDER_SECRET);
      }
    });

    it.each([
      ['the placeholder of .env.example', PLACEHOLDER_SECRET],
      ['a value containing change_me', 'x9K2change_me7Lq4ZpW8nYc3HdF6sJg1AeU5o'],
      ['a value containing changeme', 'x9K2CHANGEME7Lq4ZpW8nYc3HdF6sJg1AeU5oX'],
      ['a value containing example', 'x9K2example7Lq4ZpW8nYc3HdF6sJg1AeU5oXi'],
      ['one repeated character', 'a'.repeat(40)],
      ['a short repeated pattern', 'abc123'.repeat(8)],
    ])('refuses %s in production, also when NODE_ENV is not set', (_name, secret) => {
      for (const nodeEnv of ['production', undefined]) {
        const message = messageOf({
          ...BASE,
          ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
          AUTH_ACCESS_TOKEN_SECRET: secret,
        });
        expect(message).toContain('- AUTH_ACCESS_TOKEN_SECRET:');
        expect(message).not.toContain(secret);
      }
    });

    it('accepts a random secret in production and keeps it unchanged', () => {
      const env = validateEnv({ ...BASE, NODE_ENV: 'production' });
      expect(env.AUTH_ACCESS_TOKEN_SECRET).toBe(STRONG_SECRET);
      expect(weakSecretReason(STRONG_SECRET)).toBeNull();
    });
  });

  describe('WEB_APP_URL', () => {
    it('must be https in production, and may be http in development', () => {
      expect(
        messageOf({ ...BASE, NODE_ENV: 'production', WEB_APP_URL: 'http://localhost:3000' }),
      ).toContain('- WEB_APP_URL: must be an https:// URL in production');
      expect(
        validateEnv({ ...BASE, NODE_ENV: 'development', WEB_APP_URL: 'http://localhost:3000' })
          .WEB_APP_URL,
      ).toBe('http://localhost:3000');
    });

    it.each([['not a url'], ['ftp://example.com'], ['javascript:alert(1)']])(
      'refuses %p',
      (value) => {
        expect(messageOf({ ...BASE, NODE_ENV: 'development', WEB_APP_URL: value })).toContain(
          '- WEB_APP_URL: must be an http(s) URL',
        );
      },
    );
  });

  describe('the optional auth settings', () => {
    it.each([
      ['7', 7],
      ['', 0],
      [' 2 ', 2],
    ])('reads TRUST_PROXY_HOPS %j as %i', (value, expected) => {
      expect(validateEnv({ ...BASE, TRUST_PROXY_HOPS: value }).TRUST_PROXY_HOPS).toBe(expected);
    });

    it.each(['-1', '11', '1.5', 'true'])('refuses TRUST_PROXY_HOPS %j', (value) => {
      expect(() => validateEnv({ ...BASE, TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
    });

    it('have documented defaults', () => {
      expect(validateEnv({ ...BASE, NODE_ENV: 'production' })).toEqual({
        NODE_ENV: 'production',
        DATABASE_URL: BASE.DATABASE_URL,
        DATABASE_CONNECT_TIMEOUT_MS: 5000,
        API_HOST: '0.0.0.0',
        API_PORT: 3001,
        CORS_ORIGINS: ['http://localhost:3000', 'http://localhost:3002'],
        LOG_LEVEL: 'log',
        TRUST_PROXY_HOPS: 0,
        AUTH_ACCESS_TOKEN_SECRET: STRONG_SECRET,
        AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
        AUTH_REFRESH_TOKEN_TTL_DAYS: 30,
        AUTH_SESSION_ABSOLUTE_TTL_DAYS: 90,
        AUTH_REFRESH_REUSE_GRACE_SECONDS: 10,
        AUTH_ACTIVATION_CODE_TTL_HOURS: 72,
        AUTH_RESET_CODE_TTL_MINUTES: 60,
        AUTH_MAX_FAILED_LOGINS: 5,
        AUTH_LOCKOUT_MINUTES: 15,
        AUTH_COOKIE_DOMAIN: undefined,
        WEB_APP_URL: 'https://app.example.com',
      });
    });

    it('are read as numbers, and an empty value means the default', () => {
      const env = validateEnv({
        ...BASE,
        AUTH_ACCESS_TOKEN_TTL_SECONDS: '300',
        AUTH_MAX_FAILED_LOGINS: '3',
        AUTH_LOCKOUT_MINUTES: '',
        AUTH_COOKIE_DOMAIN: '',
      });
      expect(env.AUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(300);
      expect(env.AUTH_MAX_FAILED_LOGINS).toBe(3);
      expect(env.AUTH_LOCKOUT_MINUTES).toBe(15);
      expect(env.AUTH_COOKIE_DOMAIN).toBeUndefined();
    });

    it.each([
      ['AUTH_ACCESS_TOKEN_TTL_SECONDS', '0'],
      ['AUTH_ACCESS_TOKEN_TTL_SECONDS', 'soon'],
      ['AUTH_REFRESH_TOKEN_TTL_DAYS', '0'],
      ['AUTH_MAX_FAILED_LOGINS', '0'],
      ['AUTH_MAX_FAILED_LOGINS', '2.5'],
      ['AUTH_LOCKOUT_MINUTES', '-1'],
      ['AUTH_COOKIE_DOMAIN', 'https://example.com'],
    ])('refuses %s=%p', (name, value) => {
      expect(messageOf({ ...BASE, [name]: value })).toContain(`- ${name}:`);
    });

    it('refuses an absolute session lifetime shorter than the sliding one', () => {
      expect(
        messageOf({
          ...BASE,
          AUTH_REFRESH_TOKEN_TTL_DAYS: '30',
          AUTH_SESSION_ABSOLUTE_TTL_DAYS: '7',
        }),
      ).toContain('- AUTH_SESSION_ABSOLUTE_TTL_DAYS:');
    });
  });

  describe('the removed development header', () => {
    it('has no switch any more: DEV_AUTH_ENABLED is ignored and not part of the result', () => {
      const env = validateEnv({ ...BASE, NODE_ENV: 'development', DEV_AUTH_ENABLED: 'true' });
      expect(env).not.toHaveProperty('DEV_AUTH_ENABLED');
    });
  });

  describe('the rest of the environment', () => {
    it('lists every missing variable in one error', () => {
      const message = messageOf({});
      for (const name of REQUIRED) {
        expect(message).toContain(`- ${name}:`);
      }
    });

    it('never puts a value in the error message', () => {
      const message = messageOf({
        ...BASE,
        DATABASE_URL: 'mysql://user:hunter2-example@localhost/db',
        API_PORT: '99999',
        AUTH_ACCESS_TOKEN_SECRET: 'too-short-hunter3',
        WEB_APP_URL: 'nonsense-hunter4',
      });
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('API_PORT');
      expect(message).toContain('AUTH_ACCESS_TOKEN_SECRET');
      expect(message).toContain('WEB_APP_URL');
      expect(message).not.toContain('hunter2-example');
      expect(message).not.toContain('99999');
      expect(message).not.toContain('hunter3');
      expect(message).not.toContain('hunter4');
    });

    it.each([
      ['DATABASE_CONNECT_TIMEOUT_MS', '0'],
      ['DATABASE_CONNECT_TIMEOUT_MS', 'soon'],
      ['API_PORT', '0'],
      ['API_PORT', '3001.5'],
      ['LOG_LEVEL', 'loud'],
      ['API_HOST', '   '],
    ])('refuses %s=%p', (name, value) => {
      expect(messageOf({ ...BASE, [name]: value })).toContain(`- ${name}:`);
    });
  });
});

describe('logLevelsFrom', () => {
  it('enables the given level and everything more severe', () => {
    expect(logLevelsFrom('warn')).toEqual(['warn', 'error', 'fatal']);
    expect(logLevelsFrom('verbose')).toHaveLength(6);
  });
});
