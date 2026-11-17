import type { CatalogueShape } from '@ops/shared';

import type { settings as enSettings } from '../en/settings';

export const settings: CatalogueShape<typeof enSettings> = {
  description: 'اسم المؤسسة والقواعد التي تتبعها التطبيقات.',
  apiStatus: 'حالة الواجهة البرمجية',
  noApiUrl: 'لا يوجد عنوان للواجهة البرمجية',
  checkAgain: 'تحقّق مجددًا',
  general: 'المؤسسة',
  rules: 'قواعد سجلات العمل',
  name: 'اسم المؤسسة',
  slug: 'معرّف تسجيل الدخول: {{slug}}',
  timeZone: 'المنطقة الزمنية',
  timeZoneHint:
    'تُعرض الأوقات في اللوحة والتقارير والملفات المصدّرة بهذه المنطقة، ويُحسب "اليوم" وفقها.',
  workLogEditWindowHours: 'مهلة التعديل (بالساعات)',
  workLogEditWindowHoursHint:
    'المدة التي يظل فيها لكاتب سجل العمل حق تعديله بعد إنشائه. {{max}} ساعة كحد أقصى.',
  offlineMaxBackdateDays: 'حد التأريخ بأثر رجعي دون اتصال (بالأيام)',
  offlineMaxBackdateDaysHint:
    'عدد الأيام التي يمكن أن يعود إليها تاريخ سجل جديد محفوظ دون اتصال. من 1 إلى {{max}} يومًا.',
  submit: 'حفظ الإعدادات',
  saved: 'تم حفظ الإعدادات.',
  reset: 'التراجع عن التغييرات',
  needsAdmin: 'يمكن للمسؤولين فقط رؤية الإعدادات وتغييرها.',
  errors: {
    required: 'مطلوب.',
    number: 'أدخل رقمًا.',
    range: 'خارج النطاق المسموح.',
    wholeNumber: 'أدخل عددًا صحيحًا.',
    timeZone: 'اختر منطقة زمنية صالحة.',
  },
};
