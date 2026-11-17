import type { CatalogueShape } from '@ops/shared';

import type { overview as enOverview } from '../en/overview';

export const overview: CatalogueShape<typeof enOverview> = {
  description: 'ما يحدث اليوم ضمن نطاق مسؤوليتك.',
  dayLabel: 'اليوم',
  forDay: 'أرقام يوم {{day}}',
  updatedAt: 'آخر تحديث {{time}}',
  refresh: 'تحديث',
  numbersLabel: 'الأرقام الرئيسية',
  openList: '{{label}}: {{count}}. افتح القائمة.',
  cards: {
    logsToday: 'سجلات هذا اليوم',
    logsAwaitingApproval: 'بانتظار الموافقة',
    tasksOpen: 'المهام المفتوحة',
    tasksOverdue: 'المهام المتأخرة',
    tasksBlocked: 'المهام المتوقفة',
  },
  activity: {
    bySite: 'النشاط حسب الموقع',
    byTeam: 'النشاط حسب الفريق',
    name: 'الاسم',
    logs: 'السجلات',
    openTasks: 'المهام المفتوحة',
    noSite: 'بلا موقع',
    noTeam: 'بلا فريق',
    unknownPlace: 'مكان لا تملك صلاحية رؤيته',
    empty: 'لا يوجد نشاط في هذا اليوم.',
    logsLink: '{{count}} سجل في {{name}}. افتح القائمة.',
    tasksLink: '{{count}} مهمة مفتوحة في {{name}}. افتح القائمة.',
  },
  idle: {
    heading: 'عمّال بلا نشاط',
    caption: 'العمّال الذين لم يسجّلوا شيئًا في هذا اليوم',
    description: 'العمّال ضمن نطاقك الذين لم يسجّلوا أي شيء في هذا اليوم.',
    count: {
      zero: 'لا عمّال',
      one: 'عامل واحد',
      two: 'عاملان',
      few: '{{count}} عمّال',
      many: '{{count}} عاملًا',
      other: '{{count}} عامل',
    },
    name: 'العامل',
    lastLog: 'آخر سجل',
    never: 'أبدًا',
    openLogs: 'سجلاته',
    openLogsOf: 'افتح سجلات {{name}}',
    none: 'سجّل كل عامل شيئًا في هذا اليوم.',
    truncated: 'يُعرض أول {{shown}} من أصل {{total}}.',
  },
};
