import type { Metadata } from 'next';

import { StructurePage } from '@/components/structure/structure-page';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('pages.structure.title') };

export default function Page() {
  return <StructurePage />;
}
