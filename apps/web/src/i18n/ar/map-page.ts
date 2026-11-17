import type { CatalogueShape } from '@ops/shared';

import type { mapPage as enMapPage } from '../en/map-page';

export const mapPage: CatalogueShape<typeof enMapPage> = {
  description: 'أحدث سجلات العمل التي سجّلت موقعًا.',
  mapLabel: 'خريطة أحدث سجلات العمل',
  range: 'من {{from}} إلى {{to}}',
  defaultRange: 'من دون تصفية بالتاريخ تعرض الخريطة آخر {{days}} يومًا.',
  shown: {
    zero: 'لا سجلات على الخريطة',
    one: 'سجل واحد على الخريطة',
    two: 'سجلان على الخريطة',
    few: '{{count}} سجلات على الخريطة',
    many: '{{count}} سجلًا على الخريطة',
    other: '{{count}} سجل على الخريطة',
  },
  truncated: 'يُعرض أحدث {{shown}} من أصل {{total}}. ضيّق عوامل التصفية لرؤية البقية.',
  listHeading: 'السجلات على الخريطة',
  listCaption: 'سجلات العمل ذات الموقع',
  openLog: 'فتح السجل',
  popupPhotos: {
    zero: 'لا صور',
    one: 'صورة واحدة',
    two: 'صورتان',
    few: '{{count}} صور',
    many: '{{count}} صورة',
    other: '{{count}} صورة',
  },
  empty: 'لا يوجد سجل عمل بموقع يطابق عوامل التصفية هذه.',
  coordinates: 'الموقع',
};
