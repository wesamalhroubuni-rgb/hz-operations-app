import type { Metadata } from 'next';

import { SummaryHistoryPage } from '@/components/ai/summary-history-page';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('ai.pages.summaries') };

export default function Page() {
  return <SummaryHistoryPage />;
}
