import type { Metadata } from 'next';

import { MapPage } from '@/components/map-page/map-page';
import { t } from '@/i18n';

// Map (agent B, ADR-0009): recent located work logs within the filters (GET /work-logs/map).
export const metadata: Metadata = { title: t('pages.map.title') };

export default function Page() {
  return <MapPage />;
}
