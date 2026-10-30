import type { Metadata } from 'next';

import { PeoplePage } from '@/components/people/people-page';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('pages.people.title') };

export default function Page() {
  return <PeoplePage />;
}
