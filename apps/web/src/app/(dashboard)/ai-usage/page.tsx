import type { Metadata } from 'next';

import { AiUsagePage } from '@/components/ai/ai-usage-page';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('ai.pages.usage') };

export default function Page() {
  return <AiUsagePage />;
}
