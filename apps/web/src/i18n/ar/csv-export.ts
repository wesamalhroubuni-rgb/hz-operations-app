import type { CatalogueShape } from '@ops/shared';

import type { csvExport as enCsvExport } from '../en/csv-export';

export const csvExport: CatalogueShape<typeof enCsvExport> = {
  button: 'تصدير CSV',
  exporting: 'جارٍ التصدير…',
  hint: 'يصدّر كل الصفوف المطابقة لعوامل التصفية الحالية (وليس هذه الصفحة فقط).',
  done: 'تم تنزيل الملف.',
  tooLarge:
    'عدد الصفوف أكبر من أن يُصدَّر: يتّسع الملف الواحد لـ {{max}} صف كحد أقصى. ضيّق عوامل التصفية (مثل فترة زمنية أقصر) ثم أعد المحاولة.',
  forbidden: 'لا يمكن لدورك تصدير هذه القائمة.',
  failed: 'فشل التصدير: {{reason}}',
};
