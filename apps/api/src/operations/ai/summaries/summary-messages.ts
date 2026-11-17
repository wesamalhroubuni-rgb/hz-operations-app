import { DEFAULT_LOCALE, localeOf, type DailySummaryStats, type Locale } from '@ops/shared';
import type { RenderedNotification } from '../../notifications/notification-messages';

// The texts of daily summaries written by code (Phase 7, ADR-0011): the template narrative used
// whenever the AI cannot write one, and the notification of a new summary. Keyed by locale and
// key; English is complete, and a key missing from another catalogue falls back to English, key
// by key (like the other notifications). Every number comes from `stats`.

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

interface TemplateCatalogue {
  intro: (vars: { day: string }) => string;
  logs: (vars: DailySummaryStats['logs']) => string;
  noLogs: () => string;
  reviews: (vars: { approved: number; rejected: number; awaiting: number }) => string;
  tasks: (vars: DailySummaryStats['tasks']) => string;
  workers: (vars: DailySummaryStats['workers']) => string;
  busiestSite: (vars: { name: string; logs: number }) => string;
  anomalies: (vars: DailySummaryStats['anomalies']) => string;
  noAnomalies: () => string;
}

interface NotificationCatalogue {
  dailySummary: (vars: {
    day: string;
    logs: number;
    overdue: number;
    anomalies: number;
  }) => RenderedNotification;
}

type Catalogue = TemplateCatalogue & NotificationCatalogue;

const ENGLISH: Catalogue = {
  intro: ({ day }) => `Daily summary for ${day}.`,
  logs: ({ total, approved, submitted, rejected, draft }) =>
    `${plural(total, 'work log was', 'work logs were')} recorded: ${approved} approved, ` +
    `${submitted} submitted, ${rejected} rejected and ${plural(draft, 'draft', 'drafts')}.`,
  noLogs: () => 'No work logs were recorded.',
  reviews: ({ approved, rejected, awaiting }) =>
    `Reviews during the day: ${approved} approved, ${rejected} rejected. ` +
    `${plural(awaiting, 'log awaits', 'logs await')} review.`,
  tasks: ({ open, overdue, blocked, completed, created }) =>
    `Tasks: ${open} open, ${overdue} overdue, ${blocked} blocked; ${completed} completed and ` +
    `${created} created during the day.`,
  workers: ({ active, idle }) => `Workers: ${active} with a log, ${idle} without a log.`,
  busiestSite: ({ name, logs }) => `Most activity: ${name} (${plural(logs, 'log', 'logs')}).`,
  anomalies: ({ total, byKind }) => {
    const parts = [
      byKind.no_activity_site > 0
        ? plural(byKind.no_activity_site, 'active site without a log', 'active sites without a log')
        : null,
      byKind.slow_task > 0 ? plural(byKind.slow_task, 'slow task', 'slow tasks') : null,
      byKind.repeated_rejections > 0
        ? plural(
            byKind.repeated_rejections,
            'worker with repeated rejections',
            'workers with repeated rejections',
          )
        : null,
      byKind.far_location > 0
        ? plural(byKind.far_location, 'log far from its site', 'logs far from their site')
        : null,
    ].filter((part): part is string => part !== null);
    return `${plural(total, 'unusual item was', 'unusual items were')} flagged for a look: ${parts.join(', ')}.`;
  },
  noAnomalies: () => 'No unusual items were flagged.',
  dailySummary: ({ day, logs, overdue, anomalies }) => ({
    title: `Daily summary for ${day}`,
    body:
      `${plural(logs, 'work log', 'work logs')}, ${plural(overdue, 'overdue task', 'overdue tasks')}, ` +
      `${plural(anomalies, 'unusual item', 'unusual items')}. Open the dashboard to read it.`,
    // Generic: a locked phone shows it to anyone holding it.
    push: { title: 'Daily summary', body: 'Your daily summary is ready.' },
  }),
};

// Turkish: a noun after a number stays singular, so no plural forms are needed.
const TURKISH: Catalogue = {
  intro: ({ day }) => `${day} günlük özeti.`,
  logs: ({ total, approved, submitted, rejected, draft }) =>
    `${total} iş kaydı girildi: ${approved} onaylandı, ${submitted} gönderildi, ` +
    `${rejected} reddedildi ve ${draft} taslak.`,
  noLogs: () => 'İş kaydı girilmedi.',
  reviews: ({ approved, rejected, awaiting }) =>
    `Gün içindeki incelemeler: ${approved} onay, ${rejected} ret. ${awaiting} kayıt inceleme bekliyor.`,
  tasks: ({ open, overdue, blocked, completed, created }) =>
    `Görevler: ${open} açık, ${overdue} gecikmiş, ${blocked} engellenmiş; gün içinde ` +
    `${completed} tamamlandı ve ${created} oluşturuldu.`,
  workers: ({ active, idle }) => `Çalışanlar: ${active} kişinin kaydı var, ${idle} kişinin yok.`,
  busiestSite: ({ name, logs }) => `En yoğun yer: ${name} (${logs} kayıt).`,
  anomalies: ({ total, byKind }) => {
    const parts = [
      byKind.no_activity_site > 0 ? `${byKind.no_activity_site} kayıtsız aktif saha` : null,
      byKind.slow_task > 0 ? `${byKind.slow_task} yavaş görev` : null,
      byKind.repeated_rejections > 0
        ? `${byKind.repeated_rejections} tekrar tekrar reddedilen çalışan`
        : null,
      byKind.far_location > 0 ? `${byKind.far_location} sahasından uzak kayıt` : null,
    ].filter((part): part is string => part !== null);
    return `${total} olağan dışı öğe incelenmek üzere işaretlendi: ${parts.join(', ')}.`;
  },
  noAnomalies: () => 'Olağan dışı öğe işaretlenmedi.',
  dailySummary: ({ day, logs, overdue, anomalies }) => ({
    title: `${day} günlük özeti`,
    body:
      `${logs} iş kaydı, ${overdue} geciken görev, ${anomalies} olağan dışı öğe. ` +
      'Okumak için paneli açın.',
    push: { title: 'Günlük özet', body: 'Günlük özetiniz hazır.' },
  }),
};

// Arabic: "label: number" phrasing, correct for every count without the six plural forms.
const ARABIC: Catalogue = {
  intro: ({ day }) => `الملخص اليومي ليوم ${day}.`,
  logs: ({ total, approved, submitted, rejected, draft }) =>
    `سجلات العمل المسجّلة: ${total} (تمت الموافقة: ${approved}، مُرسلة: ${submitted}، ` +
    `مرفوضة: ${rejected}، مسودات: ${draft}).`,
  noLogs: () => 'لم تُسجَّل أي سجلات عمل.',
  reviews: ({ approved, rejected, awaiting }) =>
    `المراجعات خلال اليوم: موافقة ${approved}، رفض ${rejected}. بانتظار المراجعة: ${awaiting}.`,
  tasks: ({ open, overdue, blocked, completed, created }) =>
    `المهام: مفتوحة ${open}، متأخرة ${overdue}، متوقفة ${blocked}؛ وخلال اليوم أُنجزت ` +
    `${completed} وأُنشئت ${created}.`,
  workers: ({ active, idle }) => `العمّال: لديهم سجل ${active}، بلا سجل ${idle}.`,
  busiestSite: ({ name, logs }) => `الأكثر نشاطًا: ${name} (السجلات: ${logs}).`,
  anomalies: ({ total, byKind }) => {
    const parts = [
      byKind.no_activity_site > 0 ? `مواقع نشطة بلا سجلات: ${byKind.no_activity_site}` : null,
      byKind.slow_task > 0 ? `مهام بطيئة: ${byKind.slow_task}` : null,
      byKind.repeated_rejections > 0 ? `عمّال برفض متكرر: ${byKind.repeated_rejections}` : null,
      byKind.far_location > 0 ? `سجلات بعيدة عن موقعها: ${byKind.far_location}` : null,
    ].filter((part): part is string => part !== null);
    return `عناصر غير معتادة للمراجعة: ${total} (${parts.join('، ')}).`;
  },
  noAnomalies: () => 'لم تُرصد عناصر غير معتادة.',
  dailySummary: ({ day, logs, overdue, anomalies }) => ({
    title: `الملخص اليومي ليوم ${day}`,
    body:
      `سجلات العمل: ${logs}، المهام المتأخرة: ${overdue}، العناصر غير المعتادة: ${anomalies}. ` +
      'افتح لوحة الإدارة لقراءته.',
    push: { title: 'الملخص اليومي', body: 'ملخصك اليومي جاهز.' },
  }),
};

/** Translations by locale; a key missing from a catalogue falls back to English. */
const CATALOGUES: Record<Locale, Partial<Catalogue>> = {
  en: ENGLISH,
  tr: TURKISH,
  ar: ARABIC,
};

function text<Key extends keyof Catalogue>(locale: string, key: Key): Catalogue[Key] {
  return (CATALOGUES[localeOf(locale)][key] ?? ENGLISH[key]) as Catalogue[Key];
}

/**
 * The deterministic narrative of a summary, from its numbers only: used when the feature is on
 * but the AI is unavailable, over its limit, refusing, or invalid twice.
 */
export function templateNarrative(
  stats: DailySummaryStats,
  locale: string = DEFAULT_LOCALE,
): string {
  const lines = [text(locale, 'intro')({ day: stats.day })];
  lines.push(stats.logs.total > 0 ? text(locale, 'logs')(stats.logs) : text(locale, 'noLogs')());
  lines.push(
    text(
      locale,
      'reviews',
    )({
      approved: stats.reviews.approved,
      rejected: stats.reviews.rejected,
      awaiting: stats.awaitingApproval,
    }),
  );
  lines.push(text(locale, 'tasks')(stats.tasks));
  lines.push(text(locale, 'workers')(stats.workers));
  const busiest = stats.bySite.find((row) => row.name !== null && row.logs > 0);
  if (busiest?.name) {
    lines.push(text(locale, 'busiestSite')({ name: busiest.name, logs: busiest.logs }));
  }
  lines.push(
    stats.anomalies.total > 0
      ? text(locale, 'anomalies')(stats.anomalies)
      : text(locale, 'noAnomalies')(),
  );
  return lines.join(' ');
}

/** The in-app and push texts of the `ai.daily_summary` notification, in the locale. */
export function renderDailySummaryNotification(
  vars: { day: string; logs: number; overdue: number; anomalies: number },
  locale: string = DEFAULT_LOCALE,
): RenderedNotification {
  return text(locale, 'dailySummary')(vars);
}
