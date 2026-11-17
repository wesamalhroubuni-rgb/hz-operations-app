import type { CatalogueShape } from '@ops/shared';

import type { overview as enOverview } from '../en/overview';

export const overview: CatalogueShape<typeof enOverview> = {
  description: 'Sorumluluk alanınızda bugün neler oluyor.',
  dayLabel: 'Gün',
  forDay: '{{day}} için rakamlar',
  updatedAt: '{{time}} itibarıyla güncellendi',
  refresh: 'Yenile',
  numbersLabel: 'Temel rakamlar',
  openList: '{{label}}: {{count}}. Listeyi aç.',
  cards: {
    logsToday: 'Bu günkü kayıtlar',
    logsAwaitingApproval: 'Onay bekleyenler',
    tasksOpen: 'Açık görevler',
    tasksOverdue: 'Geciken görevler',
    tasksBlocked: 'Engellenen görevler',
  },
  activity: {
    bySite: 'Sahaya göre etkinlik',
    byTeam: 'Ekibe göre etkinlik',
    name: 'Ad',
    logs: 'Kayıtlar',
    openTasks: 'Açık görevler',
    noSite: 'Sahasız',
    noTeam: 'Ekipsiz',
    unknownPlace: 'Göremediğiniz bir yer',
    empty: 'Bu gün etkinlik yok.',
    logsLink: '{{name}} için {{count}} kayıt. Listeyi aç.',
    tasksLink: '{{name}} için {{count}} açık görev. Listeyi aç.',
  },
  idle: {
    heading: 'Etkinliği olmayan çalışanlar',
    caption: 'Bu gün kaydı olmayan çalışanlar',
    description: 'Sorumluluk alanınızda bu gün hiçbir şey kaydetmeyen çalışanlar.',
    count: { one: '{{count}} çalışan', other: '{{count}} çalışan' },
    name: 'Çalışan',
    lastLog: 'Son kayıt',
    never: 'Hiç',
    openLogs: 'Kayıtları',
    openLogsOf: '{{name}} adlı kişinin kayıtlarını aç',
    none: 'Bu gün her çalışan bir şey kaydetti.',
    truncated: '{{total}} kişiden ilk {{shown}} gösteriliyor.',
  },
};
