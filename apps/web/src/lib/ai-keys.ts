import type { AiKeyProvider, AiProviderKeyStatus } from '@ops/shared';

import { t, type TranslationKey } from '@/i18n';
import { describeError, failureOf } from '@/lib/api/errors';

/** The settings page's own provider-key card (ADR-0012). Pure helpers, tested. */

export const AI_KEY_PROVIDER_LABELS: Record<AiKeyProvider, TranslationKey> = {
  anthropic: 'ai.keys.providers.anthropic',
  openai: 'ai.keys.providers.openai',
};

/** One sentence saying which key is in force for a provider. */
export function aiKeyStatusText(
  status: AiProviderKeyStatus,
  formatTime: (iso: string) => string,
): string {
  if (status.unreadable) {
    return t('ai.keys.status.unreadable', { hint: status.hint ?? '' });
  }
  switch (status.source) {
    case 'organization':
      return status.updatedAt
        ? t('ai.keys.status.organizationSince', {
            hint: status.hint ?? '',
            time: formatTime(status.updatedAt),
          })
        : t('ai.keys.status.organization', { hint: status.hint ?? '' });
    case 'environment':
      return t('ai.keys.status.environment');
    case 'test':
      return t('ai.keys.status.test');
    case 'none':
      return t('ai.keys.status.none');
  }
}

/**
 * The message of a failed save: the typed codes first, then the generic description. `model` is
 * the model the key was checked against (shown when the key has no access to it).
 */
export function aiKeyErrorMessage(error: unknown, model: string): string {
  const failure = failureOf(error);
  if (failure?.kind === 'http') {
    switch (failure.error.code) {
      case 'ai_key_invalid':
        return failure.error.details?.some((detail) => detail.path === 'model')
          ? t('ai.keys.errors.noModelAccess', { model })
          : t('ai.keys.errors.invalid');
      case 'ai_unavailable':
        return t('ai.keys.errors.unreachable');
      case 'ai_key_storage_unavailable':
        return t('ai.keys.errors.storage');
      case 'validation_failed':
        return t('ai.keys.errors.format');
      case 'rate_limited':
        return t('ai.keys.errors.tooMany');
      default:
        break;
    }
  }
  return describeError(error);
}
