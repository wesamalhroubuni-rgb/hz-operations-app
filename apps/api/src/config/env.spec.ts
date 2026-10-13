import { logLevelsFrom, validateEnv } from './env';

// A complete, valid environment without NODE_ENV and DEV_AUTH_ENABLED. No real credentials.
const BASE = {
  DATABASE_URL: 'postgresql://user:example@localhost:5432/example_db?schema=public',
  DATABASE_CONNECT_TIMEOUT_MS: '5000',
  API_HOST: '0.0.0.0',
  API_PORT: '3001',
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:3002',
  LOG_LEVEL: 'log',
};

function messageOf(raw: Record<string, unknown>): string {
  try {
    validateEnv(raw);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('validateEnv', () => {
  describe('DEV_AUTH_ENABLED cannot be switched on outside development', () => {
    it('accepts DEV_AUTH_ENABLED=true when NODE_ENV is development', () => {
      const env = validateEnv({ ...BASE, NODE_ENV: 'development', DEV_AUTH_ENABLED: 'true' });
      expect(env.NODE_ENV).toBe('development');
      expect(env.DEV_AUTH_ENABLED).toBe(true);
    });

    it.each([['production'], ['test']])(
      'refuses DEV_AUTH_ENABLED=true when NODE_ENV is %s',
      (nodeEnv) => {
        const message = messageOf({ ...BASE, NODE_ENV: nodeEnv, DEV_AUTH_ENABLED: 'true' });
        expect(message).toContain(
          'DEV_AUTH_ENABLED: can only be true when NODE_ENV is development',
        );
      },
    );

    it('refuses DEV_AUTH_ENABLED=true when NODE_ENV is not set, because unset means production', () => {
      expect(() => validateEnv({ ...BASE, DEV_AUTH_ENABLED: 'true' })).toThrow(
        'DEV_AUTH_ENABLED: can only be true when NODE_ENV is development',
      );
      expect(validateEnv({ ...BASE }).NODE_ENV).toBe('production');
    });

    it.each([['Development'], ['dev'], ['staging'], [''], [' development']])(
      'refuses an unknown NODE_ENV (%p) altogether, so the flag cannot ride on a typo',
      (nodeEnv) => {
        const message = messageOf({ ...BASE, NODE_ENV: nodeEnv, DEV_AUTH_ENABLED: 'true' });
        expect(message).toContain('NODE_ENV: must be one of: development, test, production');
      },
    );

    it.each([
      ['production', 'false'],
      ['production', undefined],
      ['test', 'false'],
      ['test', undefined],
      ['development', 'false'],
      ['development', undefined],
      [undefined, 'false'],
      [undefined, undefined],
    ])('accepts NODE_ENV=%p with DEV_AUTH_ENABLED=%p and leaves the flag off', (nodeEnv, flag) => {
      const env = validateEnv({
        ...BASE,
        ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
        ...(flag === undefined ? {} : { DEV_AUTH_ENABLED: flag }),
      });
      expect(env.DEV_AUTH_ENABLED).toBe(false);
    });

    it.each([['1'], ['yes'], ['TRUE'], ['True'], ['on'], [''], [true], [1]])(
      'refuses a flag value that is not exactly "true" or "false" (%p), even in development',
      (flag) => {
        const message = messageOf({ ...BASE, NODE_ENV: 'development', DEV_AUTH_ENABLED: flag });
        expect(message).toContain('DEV_AUTH_ENABLED: must be true or false');
      },
    );
  });

  describe('the rest of the environment', () => {
    it('returns typed values', () => {
      expect(validateEnv({ ...BASE, NODE_ENV: 'production' })).toEqual({
        NODE_ENV: 'production',
        DEV_AUTH_ENABLED: false,
        DATABASE_URL: BASE.DATABASE_URL,
        DATABASE_CONNECT_TIMEOUT_MS: 5000,
        API_HOST: '0.0.0.0',
        API_PORT: 3001,
        CORS_ORIGINS: ['http://localhost:3000', 'http://localhost:3002'],
        LOG_LEVEL: 'log',
      });
    });

    it('lists every missing variable in one error', () => {
      const message = messageOf({});
      for (const name of Object.keys(BASE)) {
        expect(message).toContain(`- ${name}:`);
      }
    });

    it('never puts a value in the error message', () => {
      const message = messageOf({
        ...BASE,
        DATABASE_URL: 'mysql://user:hunter2-example@localhost/db',
        API_PORT: '99999',
      });
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('API_PORT');
      expect(message).not.toContain('hunter2-example');
      expect(message).not.toContain('99999');
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
