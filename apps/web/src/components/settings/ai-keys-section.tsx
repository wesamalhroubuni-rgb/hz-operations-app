'use client';

import type { AiKeyProvider, AiProviderKeyStatus, AiProviderKeys } from '@ops/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { FormAlert, Notice, Warning } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/form-field';
import { t } from '@/i18n';
import { AI_KEY_PROVIDER_LABELS, aiKeyErrorMessage, aiKeyStatusText } from '@/lib/ai-keys';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';
import { useOrgTime } from '@/hooks/use-organization';

import styles from '../manage/manage.module.css';

/**
 * Settings page, admins: the organization's own AI provider keys (ADR-0012). The admin pastes
 * a Claude key (and optionally an OpenAI key for voice notes); the API checks it with the
 * provider and stores it encrypted. The key is never shown again: only its last four characters.
 */
export function AiKeysSection() {
  const query = useQuery<AiProviderKeys>({
    queryKey: queryKeys.ai.keys,
    queryFn: async () => unwrap(await requireApiClient().aiKeys.get()),
  });

  return (
    <section className={styles.card} aria-labelledby="settings-ai-keys">
      <h2 id="settings-ai-keys" className={styles.cardTitle}>
        {t('ai.keys.title')}
      </h2>
      <div className={styles.formStack}>
        <p className={styles.muted}>{t('ai.keys.description')}</p>
        {query.isError ? <FormAlert error={query.error} /> : null}
        {query.data && !query.data.storageAvailable ? (
          <Warning>{t('ai.keys.storageUnavailable')}</Warning>
        ) : null}
        {query.data?.keys.map((status) => (
          <ProviderKey
            key={status.provider}
            status={status}
            canSave={query.data.storageAvailable}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderKey({
  status,
  canSave,
}: Readonly<{ status: AiProviderKeyStatus; canSave: boolean }>) {
  const queryClient = useQueryClient();
  const orgTime = useOrgTime();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const provider: AiKeyProvider = status.provider;
  const label = t(AI_KEY_PROVIDER_LABELS[provider]);

  async function apply(action: 'save' | 'remove') {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const client = requireApiClient().aiKeys;
      const next = unwrap(
        action === 'save'
          ? await client.set(provider, { apiKey: apiKey.trim() })
          : await client.remove(provider),
      );
      queryClient.setQueryData(queryKeys.ai.keys, next);
      // The usage page shows the providers in force.
      await queryClient.invalidateQueries({ queryKey: queryKeys.ai.all });
      setApiKey('');
      setNotice(t(action === 'save' ? 'ai.keys.saved' : 'ai.keys.removed', { provider: label }));
    } catch (failure) {
      setError(aiKeyErrorMessage(failure, status.model));
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || apiKey.trim() === '') return;
    void apply('save');
  }

  return (
    <form className={styles.fieldset} onSubmit={submit} noValidate>
      <h3 className={styles.legend}>{label}</h3>
      <p className={styles.muted}>{aiKeyStatusText(status, (iso) => orgTime.dateTime(iso))}</p>
      <p className={styles.muted}>{t('ai.keys.model', { model: status.model })}</p>
      <Notice>{notice}</Notice>
      {error ? <FormAlert message={error} /> : null}
      {canSave ? (
        <>
          <FormField
            label={t(status.hint ? 'ai.keys.replaceLabel' : 'ai.keys.pasteLabel')}
            hint={t(`ai.keys.hints.${provider}`)}
          >
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            )}
          </FormField>
          <div className={styles.row}>
            <Button
              type="submit"
              variant="primary"
              busy={busy === 'save'}
              busyLabel={t('ai.keys.checking')}
              disabled={busy !== null || apiKey.trim() === ''}
            >
              {t('ai.keys.save')}
            </Button>
            {status.hint ? (
              <Button
                onClick={() => void apply('remove')}
                busy={busy === 'remove'}
                busyLabel={t('common.saving')}
                disabled={busy !== null}
              >
                {t('ai.keys.remove')}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </form>
  );
}
