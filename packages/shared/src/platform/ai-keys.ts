import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { isoDateTimeSchema } from '../common/primitives.js';

// The organization's own AI provider keys (ADR-0012). An admin pastes the organization's Claude
// (Anthropic) key, and optionally an OpenAI key for voice notes, in the dashboard. The API
// stores them encrypted and never returns them: answers carry only where the key in force comes
// from and its last four characters.

/** The providers an organization can store a key for. Must match the Prisma enum `AiKeyProvider`. */
export const AI_KEY_PROVIDERS = ['anthropic', 'openai'] as const;
export const aiKeyProviderSchema = z.enum(AI_KEY_PROVIDERS);
export type AiKeyProvider = z.infer<typeof aiKeyProviderSchema>;

/**
 * Where the key in force for a provider comes from:
 * - `organization`: the key an admin saved for this organization (wins over the others);
 * - `environment`: the server's key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`);
 * - `test`: no key; outside production the built-in test AI answers (fake, no network);
 * - `none`: no key and no test AI (production): the feature is unavailable.
 */
export const AI_KEY_SOURCES = ['organization', 'environment', 'test', 'none'] as const;
export const aiKeySourceSchema = z.enum(AI_KEY_SOURCES);
export type AiKeySource = z.infer<typeof aiKeySourceSchema>;

export const aiProviderKeyStatusSchema = z.object({
  provider: aiKeyProviderSchema,
  source: aiKeySourceSchema,
  /** Set when an organization key is stored: `…` and its last four characters. */
  hint: z.string().nullable(),
  /** When the organization key was saved; null without one. */
  updatedAt: isoDateTimeSchema.nullable(),
  /**
   * True when a key is stored but cannot be decrypted (the server's `AI_KEYS_ENCRYPTION_SECRET`
   * changed or is missing): it is not used, and an admin must paste it again.
   */
  unreadable: z.boolean(),
  /** The model this provider is used with: the organization's choice, else the server's. */
  model: z.string(),
});
export type AiProviderKeyStatus = z.infer<typeof aiProviderKeyStatusSchema>;

/** `GET /ai/keys` [ai_key.manage] (admins). */
export const aiProviderKeysSchema = z.object({
  /**
   * False when the server has no `AI_KEYS_ENCRYPTION_SECRET`: keys cannot be saved, and stored
   * ones cannot be read (the server's own keys or the test AI apply).
   */
  storageAvailable: z.boolean(),
  /** One entry per provider, in the order of {@link AI_KEY_PROVIDERS}. */
  keys: z.array(aiProviderKeyStatusSchema),
});
export type AiProviderKeys = z.infer<typeof aiProviderKeysSchema>;

/** Longest key accepted (real keys are about 100 to 200 characters). */
export const AI_KEY_MAX_LENGTH = 500;

/**
 * `PUT /ai/keys/:provider` [ai_key.manage]. The key is checked with the provider (a request that
 * generates nothing) before it is stored; a key the provider refuses is 422 `ai_key_invalid`.
 */
export const setAiProviderKeySchema = z.strictObject({
  apiKey: z
    .string()
    .trim()
    .min(20, { error: 'is too short to be an API key' })
    .max(AI_KEY_MAX_LENGTH)
    .regex(/^[\x21-\x7e]+$/, { error: 'must not contain spaces or special characters' }),
});
export type SetAiProviderKey = z.infer<typeof setAiProviderKeySchema>;

/** The last four characters of a key, as shown to admins (never more). */
export function aiKeyHint(apiKey: string): string {
  return `…${apiKey.trim().slice(-4)}`;
}

export function aiKeysEndpoints(transport: ApiTransport) {
  return {
    /** Admins: where each provider's key comes from (never the key itself). */
    get(): Promise<ApiResult<AiProviderKeys>> {
      return transport.request({ path: '/ai/keys', schema: aiProviderKeysSchema });
    },
    /** Admins: check the key with the provider and store it, encrypted. */
    set(provider: AiKeyProvider, body: SetAiProviderKey): Promise<ApiResult<AiProviderKeys>> {
      return transport.request({
        method: 'PUT',
        path: `/ai/keys/${provider}`,
        body,
        schema: aiProviderKeysSchema,
      });
    },
    /** Admins: delete the organization's key (the server's key or the test AI apply again). */
    remove(provider: AiKeyProvider): Promise<ApiResult<AiProviderKeys>> {
      return transport.request({
        method: 'DELETE',
        path: `/ai/keys/${provider}`,
        schema: aiProviderKeysSchema,
      });
    },
  };
}
