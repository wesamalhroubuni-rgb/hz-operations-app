import { createHmac } from 'node:crypto';
import { AccessTokenService } from './access-token';
import { parseCookies, readCredentials, serializeCookie } from './auth-http';
import { authSettingsFromConfig } from './auth-settings';
import type { Clock, RandomSource } from './clock';
import { CsrfTokens, isAllowedOrigin, isSafeMethod } from './csrf';
import { constantTimeEquals } from './hashing';
import {
  inferIdentifierKind,
  isValidPhone,
  isValidUsername,
  normalizeEmail,
  normalizePhone,
  normalizeUsername,
  parseLoginIdentifier,
} from './identifiers';
import {
  CODE_ALPHABET,
  formatCode,
  generateCode,
  hashCode,
  isWellFormedCode,
  normalizeCode,
} from './one-time-codes';
import { PasswordHasher } from './password-hasher';
import { checkNewPassword } from './password-policy';
import { InMemoryRateLimiter } from './rate-limiter';

// Smoke tests of the pure auth logic. The thorough suites (rotation and reuse, lockout,
// revocation, nothing secret in logs or audit) live with the test-writer.

// Example values only.
const SECRET = 'unit-test-signing-key-0123456789-abcdefghij';
const OTHER_SECRET = 'another-unit-test-key-9876543210-zyxwvutsrq';
const USER = '0190f3a2-7c1e-7000-8000-000000000001';
const ORG = '0190f3a2-7c1e-7000-8000-0000000000aa';
const SESSION = '0190f3a2-7c1e-7000-8000-0000000000b1';

class FixedClock implements Clock {
  constructor(private time = Date.UTC(2026, 9, 14, 9, 0, 0)) {}
  now(): Date {
    return new Date(this.time);
  }
  advanceSeconds(seconds: number): void {
    this.time += seconds * 1000;
  }
}

describe('login identifiers', () => {
  it.each([
    ['Ada@Example.COM', 'email', 'ada@example.com'],
    ['  ada@example.com ', 'email', 'ada@example.com'],
    ['+44 (0)20 7946-0958', 'phone', '+4402079460958'],
    ['0171 555 0199', 'phone', '01715550199'],
    ['555-0199', 'phone', '5550199'],
    ['Ada.Lovelace', 'username', 'ada.lovelace'],
    ['worker_07', 'username', 'worker_07'],
    // Fewer than six digits is not a phone number: it is looked up as a username (and finds none).
    ['12345', 'username', '12345'],
  ])('reads %p as %s %p', (typed, kind, value) => {
    expect(parseLoginIdentifier(typed)).toEqual({ kind, value });
  });

  it('normalises each kind the way it is stored', () => {
    expect(normalizeEmail(' A@B.Co ')).toBe('a@b.co');
    expect(normalizePhone(' +1 (555) 010-9999 ')).toBe('+15550109999');
    expect(normalizePhone('555 010 9999')).toBe('5550109999');
    expect(normalizeUsername(' Site.Lead ')).toBe('site.lead');
  });

  it('keeps the three namespaces apart: a valid username is never read as a phone or email', () => {
    for (const username of ['abc', 'a12345678', 'j.doe-2', 'x_1']) {
      expect(isValidUsername(username)).toBe(true);
      expect(inferIdentifierKind(username)).toBe('username');
    }
    for (const invalid of ['ab', '1234567', 'a@b', 'has space', 'a'.repeat(33), 'né']) {
      expect(isValidUsername(invalid)).toBe(false);
    }
    expect(isValidPhone('+1 555 010 9999')).toBe(true);
    expect(isValidPhone('555+0109999')).toBe(false);
    expect(isValidPhone('12345')).toBe(false);
  });
});

describe('new password policy', () => {
  const person = {
    email: 'ada.lovelace@example.com',
    phone: '+15550109999',
    username: 'ada1815',
    displayName: 'Ada Lovelace',
  };

  it('accepts a long password unrelated to the person', () => {
    expect(checkNewPassword('correct horse battery', person)).toEqual([]);
  });

  it.each([
    ['too short', 'short1'],
    ['too long', 'x'.repeat(129)],
    ['a well-known password', 'Password123'],
    ['one character repeated', 'aaaaaaaaaaaa'],
    ['the email', 'ada.lovelace@example.com'],
    ['the email name inside', 'xx-ada.lovelace-2026'],
    ['the username inside', 'my-ADA1815-pass'],
    ['the phone digits inside', 'tel15550109999!'],
    ['the display name', 'Ada Lovelace'],
    ['part of the display name inside', 'lovelace-forever'],
  ])('refuses %s without repeating it', (_name, password) => {
    const problems = checkNewPassword(password, person);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe('password');
    expect(problems[0]?.message).not.toContain(password);
  });

  it('reports on the path it is given', () => {
    expect(checkNewPassword('short', {}, 'newPassword')[0]?.path).toBe('newPassword');
  });
});

describe('password hashing', () => {
  const hasher = new PasswordHasher({ memoryCost: 1024, timeCost: 1 });

  it('produces an argon2id PHC string and verifies it', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(hash).not.toContain('correct');
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse batterx')).toBe(false);
  });

  it('uses the OWASP parameters by default', async () => {
    expect(await new PasswordHasher().hash('correct horse battery')).toContain('m=19456,t=2,p=1');
  });

  it.each([[''], ['not-a-hash'], ['$argon2id$v=19$m=1,t=1,p=1$bad$bad'], ['$2b$10$abcdefghijk']])(
    'answers false, without throwing, for the malformed stored value %p',
    async (stored) => {
      await expect(hasher.verify(stored, 'anything')).resolves.toBe(false);
    },
  );

  it('does the work of a verification when there is nothing to verify against', async () => {
    await expect(hasher.verifyAgainstNothing('anything')).resolves.toBe(false);
  });
});

describe('access tokens', () => {
  const claims = { sub: USER, org: ORG, sid: SESSION };

  function forge(header: object, payload: object, key: Buffer | string): string {
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode(header)}.${encode(payload)}`;
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  }

  it('round-trips the claims and expires', () => {
    const clock = new FixedClock();
    const tokens = new AccessTokenService(SECRET, 900, clock);
    const issued = tokens.sign(claims);
    expect(issued.expiresAt.getTime()).toBe(clock.now().getTime() + 900_000);
    expect(tokens.verify(issued.token)).toEqual(claims);

    clock.advanceSeconds(899);
    expect(tokens.verify(issued.token)).toEqual(claims);
    clock.advanceSeconds(1);
    expect(tokens.verify(issued.token)).toBeNull();
    expect(tokens.verify(issued.token, { ignoreExpiry: true })).toEqual(claims);
  });

  it('refuses a token signed with another secret, and a tampered one', () => {
    const clock = new FixedClock();
    const tokens = new AccessTokenService(SECRET, 900, clock);
    const foreign = new AccessTokenService(OTHER_SECRET, 900, clock).sign(claims).token;
    expect(tokens.verify(foreign)).toBeNull();

    const [header, payload, signature] = tokens.sign(claims).token.split('.') as [
      string,
      string,
      string,
    ];
    const other = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload, 'base64url').toString()) as object),
        sub: '0190f3a2-7c1e-7000-8000-000000000099',
      }),
    ).toString('base64url');
    expect(tokens.verify(`${header}.${other}.${signature}`)).toBeNull();
    expect(tokens.verify(`${header}.${payload}.`)).toBeNull();
    expect(tokens.verify(`${header}.${payload}`)).toBeNull();
  });

  it('accepts HS256 only: no "none", no other algorithm, no extra header fields', () => {
    const clock = new FixedClock();
    const tokens = new AccessTokenService(SECRET, 900, clock);
    const now = Math.floor(clock.now().getTime() / 1000);
    const payload = {
      iss: 'kaneri.auth',
      aud: 'kaneri.api',
      ...claims,
      iat: now,
      exp: now + 900,
    };
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');

    expect(tokens.verify(`${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`)).toBeNull();
    for (const header of [
      { alg: 'HS512', typ: 'JWT' },
      { alg: 'RS256', typ: 'JWT' },
      { alg: 'hs256', typ: 'JWT' },
      { alg: 'HS256', typ: 'JWT', kid: '1' },
      { typ: 'JWT', alg: 'HS256' },
    ]) {
      // Signed with the raw secret, as an attacker confused about the key would.
      expect(tokens.verify(forge(header, payload, SECRET))).toBeNull();
    }
  });

  it('refuses wrong issuer, audience, times and claim shapes, and non-strings', () => {
    const clock = new FixedClock();
    const tokens = new AccessTokenService(SECRET, 900, clock);
    // The real derived key is private; a second service with the same secret signs alike, so
    // the only way to build "valid signature, bad claims" here is through `sign` with bad ids.
    expect(tokens.verify(tokens.sign({ ...claims, sub: 'not-a-uuid' }).token)).toBeNull();
    expect(tokens.verify(tokens.sign({ ...claims, sid: '' }).token)).toBeNull();
    for (const value of [undefined, null, 42, {}, '', 'a.b', 'a.b.c.d', 'x'.repeat(5000)]) {
      expect(tokens.verify(value)).toBeNull();
    }
    // Issued in the future beyond the allowed skew.
    const future = new AccessTokenService(
      SECRET,
      900,
      new FixedClock(clock.now().getTime() + 120_000),
    );
    expect(tokens.verify(future.sign(claims).token)).toBeNull();
  });
});

describe('CSRF tokens', () => {
  const csrf = new CsrfTokens(SECRET);

  it('is stable per session, different per session and per secret', () => {
    const token = csrf.tokenFor(SESSION);
    expect(token).toBe(csrf.tokenFor(SESSION));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(csrf.tokenFor(USER));
    expect(token).not.toBe(new CsrfTokens(OTHER_SECRET).tokenFor(SESSION));
  });

  it('is not the plain HMAC of the session id under the secret (the key is derived)', () => {
    const naive = createHmac('sha256', SECRET).update(SESSION).digest('base64url');
    expect(csrf.tokenFor(SESSION)).not.toBe(naive);
    expect(csrf.matches(SESSION, naive)).toBe(false);
  });

  it('matches only the token of that session', () => {
    expect(csrf.matches(SESSION, csrf.tokenFor(SESSION))).toBe(true);
    expect(csrf.matches(SESSION, csrf.tokenFor(USER))).toBe(false);
    for (const value of [undefined, null, '', 'x', 42, ['a'], 'x'.repeat(500)]) {
      expect(csrf.matches(SESSION, value)).toBe(false);
    }
  });

  it('knows safe methods and allowed origins', () => {
    expect(['GET', 'head', 'OPTIONS'].every(isSafeMethod)).toBe(true);
    expect(['POST', 'PUT', 'PATCH', 'DELETE', undefined, ''].some(isSafeMethod)).toBe(false);

    const allowed = ['http://localhost:3000', 'https://app.example.com/'];
    expect(isAllowedOrigin('http://localhost:3000', allowed)).toBe(true);
    expect(isAllowedOrigin('https://APP.example.com', allowed)).toBe(true);
    for (const origin of [
      undefined,
      '',
      'null',
      'http://localhost:3001',
      'https://app.example.com.evil.test',
      'https://evil.test/?http://localhost:3000',
      ['http://localhost:3000'],
    ]) {
      expect(isAllowedOrigin(origin, allowed)).toBe(false);
    }
  });

  it('compares strings in constant time without throwing on different lengths', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });
});

describe('one-time codes', () => {
  const counting: RandomSource = {
    bytes: (length) => Buffer.from(Array.from({ length }, (_, index) => index * 37 + 5)),
  };

  it('are 16 unambiguous characters (80 bits) in groups of four', () => {
    const code = generateCode(counting);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    expect(CODE_ALPHABET).toHaveLength(32);
    expect(CODE_ALPHABET).not.toMatch(/[01IO]/);
    expect(generateCode(counting)).toBe(code);
  });

  it('are accepted in any case, with or without separators', () => {
    const code = generateCode(counting);
    const bare = normalizeCode(code);
    expect(bare).toHaveLength(16);
    expect(formatCode(bare)).toBe(code);
    for (const typed of [
      code.toLowerCase(),
      bare,
      ` ${code.replaceAll('-', ' ')} `,
      bare.toLowerCase(),
    ]) {
      expect(isWellFormedCode(typed)).toBe(true);
      expect(hashCode(typed)).toBe(hashCode(code));
    }
    expect(hashCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(code)).not.toContain(bare.toLowerCase());
  });

  it('refuses what cannot be a code before any lookup', () => {
    for (const typed of [
      '',
      'ABCD',
      'ABCD-EFGH-JKLM-NPQ',
      'ABCD-EFGH-JKLM-NPQ0',
      'x'.repeat(200),
    ]) {
      expect(isWellFormedCode(typed)).toBe(false);
    }
  });
});

describe('InMemoryRateLimiter', () => {
  const rule = { limit: 3, windowSeconds: 60 };

  it('allows the limit, then refuses with the time left in the window', async () => {
    const clock = new FixedClock();
    const limiter = new InMemoryRateLimiter(clock);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await limiter.hit('k', rule)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    clock.advanceSeconds(20);
    expect(await limiter.hit('k', rule)).toEqual({ allowed: false, retryAfterSeconds: 40 });
    expect((await limiter.hit('other', rule)).allowed).toBe(true);

    clock.advanceSeconds(40);
    expect((await limiter.hit('k', rule)).allowed).toBe(true);
  });

  it('forgets everything on reset', async () => {
    const limiter = new InMemoryRateLimiter(new FixedClock());
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await limiter.hit('k', rule);
    }
    await limiter.reset();
    expect((await limiter.hit('k', rule)).allowed).toBe(true);
  });

  it('keeps its memory bounded under a flood of distinct keys', async () => {
    const clock = new FixedClock();
    const limiter = new InMemoryRateLimiter(clock, 100);
    for (let index = 0; index < 1000; index += 1) {
      await limiter.hit(`key-${index}`, rule);
    }
    expect(limiter.size).toBeLessThanOrEqual(100);

    // Expired windows go first once the window has passed.
    clock.advanceSeconds(61);
    await limiter.hit('fresh', rule);
    await limiter.hit('fresh-2', rule);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});

describe('cookies and credentials', () => {
  it('parses a Cookie header, skipping what is malformed', () => {
    expect(parseCookies('a=1; b="two"; c=%20x; broken; =y; d=%E0%A4%A; a=later')).toEqual({
      a: '1',
      b: 'two',
      c: ' x',
    });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('writes httpOnly, SameSite=Lax cookies, Secure and Domain only when asked', () => {
    expect(serializeCookie('n', 'v w', { path: '/auth', maxAge: 60.9, secure: false })).toBe(
      'n=v%20w; Path=/auth; Max-Age=60; HttpOnly; SameSite=Lax',
    );
    const secure = serializeCookie('n', 'v', {
      path: '/',
      maxAge: 60,
      secure: true,
      domain: 'example.com',
    });
    expect(secure).toContain('; Domain=example.com; Secure');
    expect(serializeCookie('n', '', { path: '/', maxAge: 0, secure: false })).toContain(
      'Max-Age=0; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
  });

  it('reads the bearer token and the session cookies of a request', () => {
    expect(
      readCredentials({
        headers: {
          authorization: 'Bearer abc.def.ghi',
          cookie: 'access_token=c1; refresh_token=c2',
        },
      }),
    ).toEqual({
      hasAuthorization: true,
      bearer: 'abc.def.ghi',
      accessCookie: 'c1',
      refreshCookie: 'c2',
    });
    expect(readCredentials({ headers: { authorization: 'Basic abc' } })).toMatchObject({
      hasAuthorization: true,
      bearer: null,
    });
    expect(readCredentials({ headers: { 'x-dev-user-id': USER } })).toEqual({
      hasAuthorization: false,
      bearer: null,
      accessCookie: null,
      refreshCookie: null,
    });
  });
});

describe('authSettingsFromConfig', () => {
  const base: Record<string, unknown> = {
    AUTH_ACCESS_TOKEN_SECRET: SECRET,
    CORS_ORIGINS: ['http://localhost:3000'],
    WEB_APP_URL: 'http://localhost:3000/',
  };
  const from = (values: Record<string, unknown>) => authSettingsFromConfig((key) => values[key]);

  it('refuses to exist without a real secret, in every environment', () => {
    for (const NODE_ENV of ['development', 'test', 'production', undefined]) {
      expect(() => from({ ...base, NODE_ENV, AUTH_ACCESS_TOKEN_SECRET: undefined })).toThrow(
        'AUTH_ACCESS_TOKEN_SECRET',
      );
      expect(() => from({ ...base, NODE_ENV, AUTH_ACCESS_TOKEN_SECRET: 'short' })).toThrow();
    }
  });

  it('applies the documented defaults and treats unknown environments as production', () => {
    const settings = from(base);
    expect(settings).toMatchObject({
      nodeEnv: 'production',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlMs: 30 * 86_400_000,
      sessionAbsoluteTtlMs: 90 * 86_400_000,
      refreshReuseGraceMs: 10_000,
      activationCodeTtlMs: 72 * 3_600_000,
      resetCodeTtlMs: 3_600_000,
      maxFailedLogins: 5,
      lockoutMs: 900_000,
      cookieSecure: true,
      cookieDomain: undefined,
      webAppUrl: 'http://localhost:3000',
    });
    expect(from({ ...base, NODE_ENV: 'development' }).cookieSecure).toBe(false);
    expect(from({ ...base, NODE_ENV: 'staging' }).cookieSecure).toBe(true);
  });
});
