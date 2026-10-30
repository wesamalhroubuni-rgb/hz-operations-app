import type { TaskPriority, TaskStatus, WorkLogStatus } from '@ops/shared';

import { t, type TranslationKey } from '@/i18n';

import styles from './ui.module.css';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'muted';

const TONE_CLASS: Record<BadgeTone, string | undefined> = {
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  info: styles.toneInfo,
  primary: styles.tonePrimary,
  muted: styles.toneMuted,
};

const WORK_LOG_TONES: Record<WorkLogStatus, BadgeTone> = {
  draft: 'muted',
  submitted: 'warning',
  approved: 'success',
  rejected: 'danger',
};

const TASK_TONES: Record<TaskStatus, BadgeTone> = {
  todo: 'muted',
  in_progress: 'info',
  blocked: 'danger',
  done: 'success',
  cancelled: 'muted',
};

const PRIORITY_TONES: Record<TaskPriority, BadgeTone> = {
  low: 'muted',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
};

/** A pill with a label and a tone. The colour is never the only signal: the text says it. */
export function Badge({ tone = 'muted', label }: Readonly<{ tone?: BadgeTone; label: string }>) {
  return <span className={`${styles.badge} ${TONE_CLASS[tone] ?? ''}`}>{label}</span>;
}

export type StatusBadgeProps =
  | { kind: 'workLog'; value: WorkLogStatus }
  | { kind: 'task'; value: TaskStatus }
  | { kind: 'priority'; value: TaskPriority }
  | { kind: 'archived' };

/** The translated status of a work log or task, a task priority, or "Archived". */
export function StatusBadge(props: Readonly<StatusBadgeProps>) {
  switch (props.kind) {
    case 'workLog':
      return (
        <Badge
          tone={WORK_LOG_TONES[props.value]}
          label={t(`status.workLog.${props.value}` as TranslationKey)}
        />
      );
    case 'task':
      return (
        <Badge
          tone={TASK_TONES[props.value]}
          label={t(`status.task.${props.value}` as TranslationKey)}
        />
      );
    case 'priority':
      return (
        <Badge
          tone={PRIORITY_TONES[props.value]}
          label={t(`priority.${props.value}` as TranslationKey)}
        />
      );
    case 'archived':
      return <Badge tone="muted" label={t('status.archived')} />;
  }
}
