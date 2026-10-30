import type { Metadata } from 'next';

import { SettingsPage } from '@/components/settings/settings-page';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('pages.settings.title') };

export default function Page() {
  return <SettingsPage />;
}
