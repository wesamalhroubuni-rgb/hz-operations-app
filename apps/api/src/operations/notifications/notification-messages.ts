import { DEFAULT_LOCALE, localeOf, type Locale } from '@ops/shared';

/**
 * The text of every Operations notification, keyed by locale and type. The recipient's
 * User.locale picks the catalogue (Phase 6, ADR-0009); a catalogue may lack any key, and a
 * missing key (today every Turkish and Arabic one) falls back to English, key by key. An
 * unknown or unsupported locale is English.
 */

export const OPERATIONS_NOTIFICATION_TYPES = [
  'task.assigned',
  'work_log.approved',
  'work_log.rejected',
] as const;
export type OperationsNotificationType = (typeof OPERATIONS_NOTIFICATION_TYPES)[number];

export interface NotificationVariables {
  'task.assigned': { taskTitle: string };
  'work_log.approved': Record<string, never>;
  'work_log.rejected': { note: string | null };
}

export interface RenderedNotification {
  /** Full text, for the in-app list (only the recipient sees it, after signing in). */
  title: string;
  body: string;
  /**
   * Generic text for the push, which a locked phone shows to anyone holding it: never a task
   * title, a rejection reason or any other record content.
   */
  push: { title: string; body: string };
}

type Catalogue = {
  [Type in OperationsNotificationType]: (
    variables: NotificationVariables[Type],
  ) => RenderedNotification;
};

export const DEFAULT_NOTIFICATION_LOCALE: Locale = DEFAULT_LOCALE;

const ENGLISH: Catalogue = {
  'task.assigned': ({ taskTitle }) => ({
    title: `New task: ${taskTitle}`,
    body: 'You have been assigned a task. Open it to see the details.',
    push: { title: 'New task assigned', body: 'Open the app to see it.' },
  }),
  'work_log.approved': () => ({
    title: 'Work log approved',
    body: 'Your work log was approved.',
    push: { title: 'Work log approved', body: 'Open the app to see it.' },
  }),
  'work_log.rejected': ({ note }) => ({
    title: 'Work log rejected',
    body: note ? `Your work log was rejected: ${note}` : 'Your work log was rejected.',
    push: { title: 'Work log rejected', body: 'Open the app for the reason.' },
  }),
};

const TURKISH: Catalogue = {
  'task.assigned': ({ taskTitle }) => ({
    title: `Yeni görev: ${taskTitle}`,
    body: 'Size bir görev atandı. Ayrıntıları görmek için açın.',
    push: { title: 'Yeni görev atandı', body: 'Görmek için uygulamayı açın.' },
  }),
  'work_log.approved': () => ({
    title: 'İş kaydı onaylandı',
    body: 'İş kaydınız onaylandı.',
    push: { title: 'İş kaydı onaylandı', body: 'Görmek için uygulamayı açın.' },
  }),
  'work_log.rejected': ({ note }) => ({
    title: 'İş kaydı reddedildi',
    body: note ? `İş kaydınız reddedildi: ${note}` : 'İş kaydınız reddedildi.',
    push: { title: 'İş kaydı reddedildi', body: 'Gerekçe için uygulamayı açın.' },
  }),
};

const ARABIC: Catalogue = {
  'task.assigned': ({ taskTitle }) => ({
    title: `مهمة جديدة: ${taskTitle}`,
    body: 'كُلّفت بمهمة. افتحها لرؤية التفاصيل.',
    push: { title: 'تم تكليفك بمهمة جديدة', body: 'افتح التطبيق لرؤيتها.' },
  }),
  'work_log.approved': () => ({
    title: 'تمت الموافقة على سجل العمل',
    body: 'تمت الموافقة على سجل عملك.',
    push: { title: 'تمت الموافقة على سجل العمل', body: 'افتح التطبيق لرؤيته.' },
  }),
  'work_log.rejected': ({ note }) => ({
    title: 'رُفض سجل العمل',
    body: note ? `رُفض سجل عملك: ${note}` : 'رُفض سجل عملك.',
    push: { title: 'رُفض سجل العمل', body: 'افتح التطبيق لمعرفة السبب.' },
  }),
};

/** Translations by locale; a key missing from a catalogue falls back to English. */
const CATALOGUES: Record<Locale, Partial<Catalogue>> = {
  en: ENGLISH,
  tr: TURKISH,
  ar: ARABIC,
};

/**
 * The title, body and push text of a notification in the locale (tr-TR reads as tr), each
 * type falling back to English when that catalogue lacks it.
 */
export function renderNotification<Type extends OperationsNotificationType>(
  type: Type,
  variables: NotificationVariables[Type],
  locale: string = DEFAULT_NOTIFICATION_LOCALE,
): RenderedNotification {
  const render = (CATALOGUES[localeOf(locale)][type] ?? ENGLISH[type]) as Catalogue[Type];
  return render(variables);
}
