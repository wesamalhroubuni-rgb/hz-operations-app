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

/** Translations by locale; English is complete, the others hold what has been translated. */
const CATALOGUES: Record<Locale, Partial<Catalogue>> = {
  en: ENGLISH,
  tr: {},
  ar: {},
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
