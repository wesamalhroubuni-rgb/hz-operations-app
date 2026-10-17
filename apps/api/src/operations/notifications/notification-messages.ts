/**
 * The text of every Operations notification, keyed by type and locale. English only today; a
 * new language is a new entry in `CATALOGUE` (the recipient's locale is not stored yet, so
 * `renderNotification` is called with the default).
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

export const DEFAULT_NOTIFICATION_LOCALE = 'en';

const CATALOGUE: Record<string, Catalogue> = {
  en: {
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
  },
};

/** The title and body of a notification, in the locale if it exists, else in English. */
export function renderNotification<Type extends OperationsNotificationType>(
  type: Type,
  variables: NotificationVariables[Type],
  locale: string = DEFAULT_NOTIFICATION_LOCALE,
): RenderedNotification {
  const catalogue = CATALOGUE[locale] ?? CATALOGUE[DEFAULT_NOTIFICATION_LOCALE]!;
  return catalogue[type](variables);
}
