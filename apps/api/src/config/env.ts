import { z } from 'zod';

/** Log levels accepted by LOG_LEVEL, ordered from most to least verbose. */
export const LOG_LEVELS = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;

export type LogLevelName = (typeof LOG_LEVELS)[number];

/**
 * Shape of the environment the API needs. Values come from the root `.env`
 * (see `.env.example`), loaded by dotenv-cli in the package scripts.
 */
const requiredString = z.string({ error: 'is required' }).trim().min(1, 'must not be empty');

export const NODE_ENVS = ['development', 'test', 'production'] as const;

/** Minimum length of the token signing secret, in every environment. */
export const AUTH_SECRET_MIN_LENGTH = 32;

/** An optional whole number with a default and bounds. An empty value counts as not set. */
function integerSetting(defaultValue: number, min: number, max: number) {
  return z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.coerce
        .number<unknown>({ error: 'must be a whole number' })
        .int('must be a whole number')
        .min(min, `must be at least ${min}`)
        .max(max, `must be at most ${max}`)
        .optional(),
    )
    .transform((value) => value ?? defaultValue);
}

/**
 * Why a signing secret is not acceptable in production, or null when it is. The answer never
 * contains the secret. Exported for the tests.
 */
export function weakSecretReason(secret: string): string | null {
  const lower = secret.toLowerCase();
  if (/change[-_ ]?me|example|placeholder|dev[-_ ]?only|secret|password/.test(lower)) {
    return 'must not be a placeholder value in production; generate a random secret';
  }
  if (new Set(secret).size < 12) {
    return 'is too repetitive for production; generate a random secret';
  }
  return null;
}

/** A required http(s) URL, without a trailing slash. */
function httpUrlSetting() {
  return requiredString
    .refine(
      (value) => {
        try {
          return ['http:', 'https:'].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { error: 'must be an http(s) URL' },
    )
    .transform((value) => value.replace(/\/+$/, ''));
}

/** An optional true/false setting. An empty value counts as not set. */
function booleanSetting(defaultValue: boolean) {
  return z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? String(defaultValue) : value))
    .pipe(z.enum(['true', 'false'], { error: 'must be true or false' }))
    .transform((value) => value === 'true');
}

export const envSchema = z
  .object({
    /**
     * Set by the package scripts (`dev` sets development, `start` sets production), not by `.env`.
     * Anything unset is treated as production, the safe default.
     */
    NODE_ENV: z
      .enum(NODE_ENVS, { error: `must be one of: ${NODE_ENVS.join(', ')}` })
      .default('production'),
    DATABASE_URL: requiredString.regex(
      /^postgres(ql)?:\/\//,
      'must be a postgresql:// connection string',
    ),
    DATABASE_CONNECT_TIMEOUT_MS: requiredString.pipe(
      z.coerce.number<string>({ error: 'must be a number of milliseconds' }).int().positive(),
    ),
    API_HOST: requiredString,
    API_PORT: requiredString.pipe(
      z.coerce.number<string>({ error: 'must be a port number' }).int().min(1).max(65535),
    ),
    CORS_ORIGINS: requiredString.transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
    LOG_LEVEL: z.enum(LOG_LEVELS, { error: `must be one of: ${LOG_LEVELS.join(', ')}` }),
    /**
     * How many reverse proxies sit in front of the API (0 = none, the default). Behind a proxy
     * the per-IP rate limits need the client address from X-Forwarded-For; without a proxy that
     * header must NOT be trusted, or anyone could pick their own IP.
     */
    TRUST_PROXY_HOPS: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value.trim() === '' ? '0' : value.trim()))
      .pipe(z.coerce.number<string>({ error: 'must be a whole number' }).int().min(0).max(10)),

    /**
     * Secret that signs access tokens and derives the CSRF key. Not trimmed: it is used as it is.
     * Changing it signs every user out.
     */
    AUTH_ACCESS_TOKEN_SECRET: z
      .string({ error: 'is required' })
      .min(AUTH_SECRET_MIN_LENGTH, `must be at least ${AUTH_SECRET_MIN_LENGTH} characters`),
    /** Lifetime of an access token. */
    AUTH_ACCESS_TOKEN_TTL_SECONDS: integerSetting(900, 30, 86_400),
    /** How long a session survives without being used (sliding). */
    AUTH_REFRESH_TOKEN_TTL_DAYS: integerSetting(30, 1, 365),
    /** How long a session can live at most, however often it is used. */
    AUTH_SESSION_ABSOLUTE_TTL_DAYS: integerSetting(90, 1, 730),
    /**
     * A refresh token presented again within this many seconds of its use is refused without
     * ending the session (two tabs renewing at once). After that, reuse ends the session.
     */
    AUTH_REFRESH_REUSE_GRACE_SECONDS: integerSetting(10, 0, 60),
    AUTH_ACTIVATION_CODE_TTL_HOURS: integerSetting(72, 1, 720),
    AUTH_RESET_CODE_TTL_MINUTES: integerSetting(60, 5, 1440),
    /** Consecutive failed sign-ins before the account is locked. */
    AUTH_MAX_FAILED_LOGINS: integerSetting(5, 1, 100),
    AUTH_LOCKOUT_MINUTES: integerSetting(15, 1, 1440),
    /** `Domain` attribute of the session cookies. Leave empty for a host-only cookie. */
    AUTH_COOKIE_DOMAIN: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value ? value : undefined))
      .refine(
        (value) => value === undefined || /^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(value),
        {
          error: 'must be a domain name',
        },
      ),
    /** Public address of the web app; activation and reset links point at it. */
    WEB_APP_URL: requiredString
      .refine(
        (value) => {
          try {
            return ['http:', 'https:'].includes(new URL(value).protocol);
          } catch {
            return false;
          }
        },
        { error: 'must be an http(s) URL' },
      )
      .transform((value) => value.replace(/\/+$/, '')),

    // --- File storage (S3-compatible: MinIO in development) ---
    /** Where the API itself reaches the storage (server to server). */
    STORAGE_ENDPOINT: httpUrlSetting(),
    /**
     * The address put into signed upload and download URLs: it must be reachable by the phones and
     * browsers that use them (in a phone test, the PC's hotspot address).
     */
    STORAGE_PUBLIC_ENDPOINT: httpUrlSetting(),
    STORAGE_REGION: requiredString,
    STORAGE_BUCKET: requiredString.regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, {
      error: 'must be a valid bucket name (lower-case letters, digits, dots, dashes)',
    }),
    STORAGE_ACCESS_KEY_ID: requiredString,
    STORAGE_SECRET_ACCESS_KEY: requiredString,
    /** true for MinIO and most S3-compatible services; false for AWS S3 virtual-host style. */
    STORAGE_FORCE_PATH_STYLE: booleanSetting(true),
    /** Largest photo accepted, in bytes (default 10 MiB). */
    UPLOAD_MAX_BYTES: integerSetting(10 * 1024 * 1024, 1024, 25 * 1024 * 1024),
    UPLOAD_URL_TTL_SECONDS: integerSetting(300, 30, 3600),
    DOWNLOAD_URL_TTL_SECONDS: integerSetting(300, 30, 3600),

    // --- Notifications ---
    /** Optional Expo access token (required only if "enhanced push security" is on in Expo). */
    EXPO_ACCESS_TOKEN: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value ? value : undefined)),
    /** Sends push notifications through Expo. The in-app list works either way. */
    PUSH_ENABLED: booleanSetting(true),
    /** Runs the outbox consumer that turns domain events into notifications. */
    OUTBOX_CONSUMER_ENABLED: booleanSetting(true),
    OUTBOX_POLL_INTERVAL_MS: integerSetting(2000, 200, 60_000),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_SESSION_ABSOLUTE_TTL_DAYS < env.AUTH_REFRESH_TOKEN_TTL_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_SESSION_ABSOLUTE_TTL_DAYS'],
        message: 'must not be shorter than AUTH_REFRESH_TOKEN_TTL_DAYS',
      });
    }
    if (env.NODE_ENV !== 'production') {
      return;
    }
    // Production refuses to boot with the placeholder from .env.example or an obviously weak
    // secret, and with links that would send a one-time code over plain HTTP.
    const weak = weakSecretReason(env.AUTH_ACCESS_TOKEN_SECRET);
    if (weak) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_ACCESS_TOKEN_SECRET'], message: weak });
    }
    if (!env.STORAGE_PUBLIC_ENDPOINT.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_PUBLIC_ENDPOINT'],
        message: 'must be an https:// URL in production',
      });
    }
    const storageSecret = weakSecretReason(env.STORAGE_SECRET_ACCESS_KEY);
    if (storageSecret) {
      ctx.addIssue({ code: 'custom', path: ['STORAGE_SECRET_ACCESS_KEY'], message: storageSecret });
    }
    if (!env.WEB_APP_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_APP_URL'],
        message: 'must be an https:// URL in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates raw environment variables and returns the typed configuration.
 * Throws one readable error listing every problem. The message names the
 * variables only; it never includes their values, so secrets are not leaked.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Invalid environment configuration:\n${problems}\n` +
      'Copy .env.example to .env in the repository root and set the values listed above.',
  );
}

/** Nest log levels enabled for a given minimum level (that level and everything more severe). */
export function logLevelsFrom(minimum: LogLevelName): LogLevelName[] {
  return LOG_LEVELS.slice(LOG_LEVELS.indexOf(minimum));
}
