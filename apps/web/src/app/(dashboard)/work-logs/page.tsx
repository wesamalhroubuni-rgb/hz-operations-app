import type { Metadata } from 'next';

import { WorkLogListPage } from '@/components/work-logs/work-log-list';
import { t } from '@/i18n';

// Work logs (agent B, ADR-0009): filters, sort and page in the URL, bulk review, CSV export.
export const metadata: Metadata = { title: t('pages.workLogs.title') };

export default function Page() {
  return <WorkLogListPage />;
}
