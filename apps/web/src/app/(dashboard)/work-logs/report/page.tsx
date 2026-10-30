import type { Metadata } from 'next';

import { ReportPage } from '@/components/report/report-page';
import { t } from '@/i18n';

// Printable work-log report (agent B, ADR-0009): GET /reports/work-logs, laid out for print.
export const metadata: Metadata = { title: t('pages.report.title') };

export default function Page() {
  return <ReportPage />;
}
