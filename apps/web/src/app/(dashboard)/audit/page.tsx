import type { Metadata } from 'next';

import { AuditPage } from '@/components/audit/audit-page';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('pages.audit.title') };

export default function Page() {
  return <AuditPage />;
}
