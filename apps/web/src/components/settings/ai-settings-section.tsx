'use client';

import {
  AI_LLM_MODEL_CHOICES,
  AI_STT_MODEL_CHOICES,
  AI_SUMMARY_RECIPIENT_ROLES,
  type AiLlmModel,
  type AiSttModel,
  MAX_AI_DAILY_COST_LIMIT_USD,
  MAX_AI_DAILY_REQUEST_LIMIT,
  type OrganizationFull,
} from '@ops/shared';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { FormAlert, Notice } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { Checkbox, FormField, Input, Select } from '@/components/ui/form-field';
import { t, type TranslationKey } from '@/i18n';
import {
  AI_USAGE_PATH,
  aiSettingsFormFrom,
  aiSettingsUpdateBody,
  toggleRecipientRole,
  type AiSettingsErrorCode,
  type AiSettingsFormState,
} from '@/lib/ai';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';

import styles from '../manage/manage.module.css';

/**
 * Settings page, admins: the intelligent features (`settings.ai`): the switches, the summary
 * time, who receives a summary, and the daily limits. Its own form and Save button; the body
 * keeps every other stored setting (`PATCH /organization` replaces the settings object).
 */
export function AiSettingsSection({ organization }: Readonly<{ organization: OrganizationFull }>) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AiSettingsFormState>(() => aiSettingsFormFrom(organization));
  const [errors, setErrors] = useState<
    Partial<Record<keyof AiSettingsFormState, AiSettingsErrorCode>>
  >({});
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorOf = (key: keyof AiSettingsFormState) =>
    errors[key] ? t(`ai.settings.errors.${errors[key]}` as TranslationKey) : null;
  const update = (change: Partial<AiSettingsFormState>) =>
    setForm((current) => ({ ...current, ...change }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFailure(null);
    setNotice(null);
    const built = aiSettingsUpdateBody(organization, form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setBusy(true);
    try {
      const saved = unwrap(await requireApiClient().organization.update(built.body));
      queryClient.setQueryData(queryKeys.organization, saved);
      setForm(aiSettingsFormFrom(saved));
      // The keys card and the usage page show the model in force.
      await queryClient.invalidateQueries({ queryKey: queryKeys.ai.all });
      setNotice(t('ai.settings.saved'));
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.stack} onSubmit={submit} noValidate>
      <section className={styles.card} aria-labelledby="settings-ai">
        <h2 id="settings-ai" className={styles.cardTitle}>
          {t('ai.settings.title')}
        </h2>
        <div className={styles.formStack}>
          <p className={styles.muted}>{t('ai.settings.description')}</p>
          <Notice>{notice}</Notice>
          <Checkbox
            label={t('ai.settings.smartCapture')}
            checked={form.smartCaptureEnabled}
            onChange={(event) => update({ smartCaptureEnabled: event.target.checked })}
          />
          <Checkbox
            label={t('ai.settings.dailySummary')}
            checked={form.dailySummaryEnabled}
            onChange={(event) => update({ dailySummaryEnabled: event.target.checked })}
          />
          <div className={styles.formGrid}>
            <FormField
              label={t('ai.settings.summaryTime')}
              hint={t('ai.settings.summaryTimeHint')}
              error={errorOf('summaryTime')}
              required
            >
              {(control) => (
                <Input
                  {...control}
                  type="time"
                  step={60}
                  value={form.summaryTime}
                  onChange={(event) => update({ summaryTime: event.target.value })}
                />
              )}
            </FormField>
            <FormField
              label={t('ai.settings.requestLimit')}
              hint={t('ai.settings.requestLimitHint')}
              error={errorOf('dailyRequestLimit')}
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_AI_DAILY_REQUEST_LIMIT}
                  step={1}
                  value={form.dailyRequestLimit}
                  onChange={(event) => update({ dailyRequestLimit: event.target.value })}
                />
              )}
            </FormField>
            <FormField
              label={t('ai.settings.costLimit')}
              hint={t('ai.settings.costLimitHint')}
              error={errorOf('dailyCostLimitUsd')}
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={MAX_AI_DAILY_COST_LIMIT_USD}
                  step="any"
                  value={form.dailyCostLimitUsd}
                  onChange={(event) => update({ dailyCostLimitUsd: event.target.value })}
                />
              )}
            </FormField>
          </div>
          <div className={styles.formGrid}>
            <FormField label={t('ai.settings.llmModel')} hint={t('ai.settings.llmModelHint')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.llmModel}
                  placeholder={t('ai.settings.serverModel')}
                  options={AI_LLM_MODEL_CHOICES.map((model) => ({
                    value: model,
                    label: t(`ai.settings.llmModels.${model}` as TranslationKey),
                  }))}
                  onChange={(event) => update({ llmModel: event.target.value as AiLlmModel | '' })}
                />
              )}
            </FormField>
            <FormField label={t('ai.settings.sttModel')} hint={t('ai.settings.sttModelHint')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.sttModel}
                  placeholder={t('ai.settings.serverModel')}
                  options={AI_STT_MODEL_CHOICES.map((model) => ({
                    value: model,
                    label: t(`ai.settings.sttModels.${model}` as TranslationKey),
                  }))}
                  onChange={(event) => update({ sttModel: event.target.value as AiSttModel | '' })}
                />
              )}
            </FormField>
          </div>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('ai.settings.recipients')}</legend>
            <p className={styles.muted}>{t('ai.settings.recipientsHint')}</p>
            {AI_SUMMARY_RECIPIENT_ROLES.map((role) => (
              <Checkbox
                key={role}
                label={t(`roles.${role}` as TranslationKey)}
                checked={form.summaryRecipientRoles.includes(role)}
                onChange={(event) =>
                  update({
                    summaryRecipientRoles: toggleRecipientRole(
                      form.summaryRecipientRoles,
                      role,
                      event.target.checked,
                    ),
                  })
                }
              />
            ))}
          </fieldset>
        </div>
      </section>
      {failure ? <FormAlert error={failure} /> : null}
      <div className={styles.row}>
        <Button type="submit" variant="primary" busy={busy} busyLabel={t('common.saving')}>
          {t('ai.settings.submit')}
        </Button>
        <Button onClick={() => setForm(aiSettingsFormFrom(organization))} disabled={busy}>
          {t('settings.reset')}
        </Button>
        <Link href={AI_USAGE_PATH} className={styles.link}>
          {t('ai.settings.usageLink')}
        </Link>
      </div>
    </form>
  );
}
