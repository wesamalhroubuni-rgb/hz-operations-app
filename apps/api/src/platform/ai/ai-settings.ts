import type { ConfigService } from '@nestjs/config';

/** How providers are chosen (`AI_PROVIDER`, ADR-0010 section 2). */
export type AiProviderMode = 'auto' | 'fake' | 'real';

/**
 * Settings of the AI layer, read from the host's `ConfigService` (validated by the host's
 * environment schema; the defaults here are the schema's). Holds the API keys: never log or
 * serialise this object.
 */
export interface AiSettings {
  mode: AiProviderMode;
  /** `production` makes a kind without a key unavailable and refuses the fakes. */
  nodeEnv: string;
  anthropicApiKey: string | null;
  openAiApiKey: string | null;
  llmModel: string;
  sttModel: string;
  requestTimeoutMs: number;
  /** The environment's ceilings per organization and UTC day. */
  dailyRequestLimit: number;
  dailyCostLimitUsd: number;
  rateLimitPerUserPerMinute: number;
  /**
   * Send Anthropic's server-side refusal fallback (`fallbacks: 'default'` + its beta) with every
   * request (`AI_ANTHROPIC_REFUSAL_FALLBACK`, default false).
   */
  anthropicRefusalFallback: boolean;
}

export const AI_SETTINGS = Symbol('platform.aiSettings');

function secret(config: ConfigService, key: string): string | null {
  const value = config.get<string>(key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function numberOr(config: ConfigService, key: string, fallback: number): number {
  const value = config.get<unknown>(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function textOr(config: ConfigService, key: string, fallback: string): string {
  const value = config.get<unknown>(key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

export function aiSettingsFromConfig(config: ConfigService): AiSettings {
  const mode = config.get<unknown>('AI_PROVIDER');
  return {
    mode: mode === 'fake' || mode === 'real' ? mode : 'auto',
    nodeEnv: textOr(config, 'NODE_ENV', 'production'),
    anthropicApiKey: secret(config, 'ANTHROPIC_API_KEY'),
    openAiApiKey: secret(config, 'OPENAI_API_KEY'),
    llmModel: textOr(config, 'AI_LLM_MODEL', 'claude-opus-5-5'),
    sttModel: textOr(config, 'AI_STT_MODEL', 'gpt-4o-transcribe'),
    requestTimeoutMs: numberOr(config, 'AI_REQUEST_TIMEOUT_MS', 30_000),
    dailyRequestLimit: numberOr(config, 'AI_DAILY_LIMIT_PER_ORG', 500),
    dailyCostLimitUsd: numberOr(config, 'AI_DAILY_COST_LIMIT_USD_PER_ORG', 10),
    rateLimitPerUserPerMinute: numberOr(config, 'AI_RATE_LIMIT_PER_USER_PER_MINUTE', 6),
    anthropicRefusalFallback: config.get<unknown>('AI_ANTHROPIC_REFUSAL_FALLBACK') === true,
  };
}
