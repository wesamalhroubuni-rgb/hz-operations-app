import type { ApiErrorCode, ApiFailure, AiProviderKeyStatus } from '@ops/shared';
import { describe, expect, it } from 'vitest';

import { t } from '@/i18n';
import { aiKeyErrorMessage, aiKeyStatusText } from '@/lib/ai-keys';
import { ApiCallError } from '@/lib/api/errors';

function httpError(
  status: number,
  code: ApiErrorCode,
  details?: Array<{ path: string; message: string }>,
): ApiCallError {
  const failure: ApiFailure = {
    kind: 'http',
    status,
    message: 'refused',
    error: {
      statusCode: status,
      code,
      message: 'refused',
      correlationId: null,
      timestamp: '2026-11-16T12:00:00.000Z',
      ...(details ? { details } : {}),
    },
  };
  return new ApiCallError(failure);
}

const status = (overrides: Partial<AiProviderKeyStatus>): AiProviderKeyStatus => ({
  provider: 'anthropic',
  source: 'test',
  hint: null,
  updatedAt: null,
  unreadable: false,
  model: 'claude-opus-5-5',
  ...overrides,
});

describe('AI provider keys (ADR-0012)', () => {
  it('says which key is in force, with the hint and the time of an own key', () => {
    const own = aiKeyStatusText(
      status({ source: 'organization', hint: '…wxyz', updatedAt: '2026-11-16T10:00:00.000Z' }),
      () => '16 Nov 13:00',
    );
    expect(own).toBe(
      t('ai.keys.status.organizationSince', { hint: '…wxyz', time: '16 Nov 13:00' }),
    );
    expect(own).toContain('…wxyz');
    expect(aiKeyStatusText(status({ source: 'environment' }), String)).toBe(
      t('ai.keys.status.environment'),
    );
    expect(aiKeyStatusText(status({ source: 'test' }), String)).toBe(t('ai.keys.status.test'));
    expect(aiKeyStatusText(status({ source: 'none' }), String)).toBe(t('ai.keys.status.none'));
  });

  it('says a stored key that cannot be read must be pasted again', () => {
    expect(
      aiKeyStatusText(status({ source: 'test', hint: '…abcd', unreadable: true }), String),
    ).toBe(t('ai.keys.status.unreadable', { hint: '…abcd' }));
  });

  it('names the model when the key has no access to it', () => {
    const error = httpError(422, 'ai_key_invalid', [{ path: 'model', message: 'no access' }]);
    expect(aiKeyErrorMessage(error, 'claude-fable-5-2')).toBe(
      t('ai.keys.errors.noModelAccess', { model: 'claude-fable-5-2' }),
    );
  });

  it.each([
    [422, 'ai_key_invalid', 'ai.keys.errors.invalid'],
    [503, 'ai_unavailable', 'ai.keys.errors.unreachable'],
    [503, 'ai_key_storage_unavailable', 'ai.keys.errors.storage'],
    [400, 'validation_failed', 'ai.keys.errors.format'],
    [429, 'rate_limited', 'ai.keys.errors.tooMany'],
  ] as const)('explains %s %s', (code, apiCode, key) => {
    expect(aiKeyErrorMessage(httpError(code, apiCode), 'm')).toBe(t(key));
  });
});
