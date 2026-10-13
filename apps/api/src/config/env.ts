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

export const envSchema = z
  .object({
    /**
     * Set by the package scripts (`dev` sets development, `start` sets production), not by `.env`.
     * Anything unset is treated as production, the safe default.
     */
    NODE_ENV: z
      .enum(NODE_ENVS, { error: `must be one of: ${NODE_ENVS.join(', ')}` })
      .default('production'),
    /**
     * TEMPORARY (until Phase 3 adds real sign-in): accept the acting user from the
     * `x-dev-user-id` header. Only allowed when NODE_ENV is development; see the check below.
     */
    DEV_AUTH_ENABLED: z
      .enum(['true', 'false'], { error: 'must be true or false' })
      .default('false')
      .transform((value) => value === 'true'),
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
  })
  .superRefine((env, ctx) => {
    // The dev header lets any caller act as any user. Refuse to boot rather than run with it
    // outside development, so it cannot be switched on in production by a stray variable.
    if (env.DEV_AUTH_ENABLED && env.NODE_ENV !== 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_AUTH_ENABLED'],
        message: 'can only be true when NODE_ENV is development',
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
