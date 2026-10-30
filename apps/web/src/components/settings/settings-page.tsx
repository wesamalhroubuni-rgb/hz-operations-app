'use client';

import {
  MAX_OFFLINE_MAX_BACKDATE_DAYS,
  MAX_WORK_LOG_EDIT_WINDOW_HOURS,
  type OrganizationFull,
} from '@ops/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { FormAlert, Notice } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { FormField, Input, Select } from '@/components/ui/form-field';
import { ApiStatus } from '@/components/api-status';
import { PageHeader } from '@/components/ui/layout';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useOrganization } from '@/hooks/use-organization';
import { t, type TranslationKey } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';
import {
  organizationUpdateBody,
  settingsFormFrom,
  timeZoneOptions,
  type SettingsErrorCode,
  type SettingsFormState,
} from '@/lib/settings';

import styles from '../manage/manage.module.css';

/** `/settings` (admins): name, time zone, edit window, offline backdating limit. */
export function SettingsPage() {
  const organization = useOrganization();
  if (organization.isLoading) return <LoadingState />;
  if (organization.error || !organization.data) {
    return <ErrorState error={organization.error} onRetry={() => void organization.refetch()} />;
  }
  if (organization.data.view !== 'full') {
    return (
      <>
        <PageHeader title={t('pages.settings.title')} />
        <EmptyState title={t('shell.notForRoleTitle')} description={t('settings.needsAdmin')} />
      </>
    );
  }
  return <SettingsForm key={organization.data.id} organization={organization.data} />;
}

function SettingsForm({ organization }: Readonly<{ organization: OrganizationFull }>) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SettingsFormState>(() => settingsFormFrom(organization));
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsFormState, SettingsErrorCode>>>(
    {},
  );
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = timeZoneOptions(form.timeZone);
  const set = (key: keyof SettingsFormState, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const errorOf = (key: keyof SettingsFormState) =>
    errors[key] ? t(`settings.errors.${errors[key]}` as TranslationKey) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFailure(null);
    setNotice(null);
    const built = organizationUpdateBody(organization, form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setBusy(true);
    try {
      const saved = unwrap(await requireApiClient().organization.update(built.body));
      queryClient.setQueryData(queryKeys.organization, saved);
      setForm(settingsFormFrom(saved));
      // Times and "today" everywhere depend on the time zone.
      await queryClient.invalidateQueries();
      setNotice(t('settings.saved'));
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={t('pages.settings.title')} description={t('settings.description')} />
      <form className={styles.stack} onSubmit={submit} noValidate>
        <Notice>{notice}</Notice>
        <section className={styles.card} aria-labelledby="settings-general">
          <h2 id="settings-general" className={styles.cardTitle}>
            {t('settings.general')}
          </h2>
          <div className={styles.formGrid}>
            <FormField
              label={t('settings.name')}
              required
              hint={t('settings.slug', { slug: organization.slug })}
              error={errorOf('name')}
            >
              {(control) => (
                <Input
                  {...control}
                  value={form.name}
                  maxLength={200}
                  onChange={(event) => set('name', event.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('settings.timeZone')}
              hint={t('settings.timeZoneHint')}
              error={errorOf('timeZone')}
            >
              {(control) => (
                <Select
                  {...control}
                  value={form.timeZone}
                  options={zones.map((zone) => ({ value: zone, label: zone }))}
                  onChange={(event) => set('timeZone', event.target.value)}
                />
              )}
            </FormField>
          </div>
        </section>
        <section className={styles.card} aria-labelledby="settings-rules">
          <h2 id="settings-rules" className={styles.cardTitle}>
            {t('settings.rules')}
          </h2>
          <div className={styles.formGrid}>
            <FormField
              label={t('settings.workLogEditWindowHours')}
              hint={t('settings.workLogEditWindowHoursHint', {
                max: MAX_WORK_LOG_EDIT_WINDOW_HOURS,
              })}
              error={errorOf('workLogEditWindowHours')}
              required
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={MAX_WORK_LOG_EDIT_WINDOW_HOURS}
                  step="any"
                  value={form.workLogEditWindowHours}
                  onChange={(event) => set('workLogEditWindowHours', event.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('settings.offlineMaxBackdateDays')}
              hint={t('settings.offlineMaxBackdateDaysHint', {
                max: MAX_OFFLINE_MAX_BACKDATE_DAYS,
              })}
              error={errorOf('offlineMaxBackdateDays')}
              required
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_OFFLINE_MAX_BACKDATE_DAYS}
                  step={1}
                  value={form.offlineMaxBackdateDays}
                  onChange={(event) => set('offlineMaxBackdateDays', event.target.value)}
                />
              )}
            </FormField>
          </div>
        </section>
        {failure ? <FormAlert error={failure} /> : null}
        <div className={styles.row}>
          <Button type="submit" variant="primary" busy={busy} busyLabel={t('common.saving')}>
            {t('settings.submit')}
          </Button>
          <Button onClick={() => setForm(settingsFormFrom(organization))} disabled={busy}>
            {t('settings.reset')}
          </Button>
        </div>
      </form>
      <ApiStatus />
    </>
  );
}
