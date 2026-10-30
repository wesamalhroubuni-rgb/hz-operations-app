import type { Metadata } from 'next';

import { OverviewPage } from '@/components/overview/overview-page';
import { t } from '@/i18n';

// Overview (agent B, ADR-0009): today's numbers for the caller's scope (GET /dashboard/overview).
export const metadata: Metadata = { title: t('pages.overview.title') };

export default function Page() {
  return <OverviewPage />;
}
