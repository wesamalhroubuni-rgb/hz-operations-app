import { z } from 'zod';

/** Log levels accepted by LOG_LEVEL, ordered from most to least verbose. */
export const LOG_LEVELS = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;

export type LogLevelName = (typeof LOG_LEVELS)[number];

/**
 * Shape of the environment the API needs. Values come from the root `.env`
 * (see `.env.example`), loaded by dotenv-cli in the package scripts.
 */
const requiredString = z.string({ error: 'is required' }).trim().min(1, 'must not be empty');

export const envSchema = z.object({
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
