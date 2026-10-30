import type { Metadata } from 'next';

import { WorkLogDetailPage } from '@/components/work-logs/work-log-detail';
import { t } from '@/i18n';

// Work log detail (agent B, ADR-0009): fields, photos, location, history, approve / reject.
export const metadata: Metadata = { title: t('pages.workLogDetail.title') };

export default async function Page({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return <WorkLogDetailPage id={id} />;
}
