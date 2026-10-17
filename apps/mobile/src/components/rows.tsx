import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  spacing,
  type Task,
  type TaskStatus,
  type WorkLog,
  type WorkLogStatus,
} from '@ops/shared';
import { I18nManager, StyleSheet, View } from 'react-native';

import { formatDateTime, t } from '../i18n';
import { parseIso } from '../logic/dates';
import { dueState } from '../logic/tasks';
import { AppText } from './AppText';
import { Badge, type Tone } from './Badge';
import { Card } from './Card';
import { iconSize } from './sizes';

export const TASK_STATUS_TONES: Record<TaskStatus, Tone> = {
  todo: 'neutral',
  in_progress: 'info',
  blocked: 'warning',
  done: 'success',
  cancelled: 'neutral',
};

export const LOG_STATUS_TONES: Record<WorkLogStatus, Tone> = {
  draft: 'neutral',
  submitted: 'info',
  approved: 'success',
  rejected: 'danger',
};

/** "Overdue", "Due today", "Due 18 Oct 2026, 09:00" or "No due date", with its tone. */
export function dueLabel(
  task: Pick<Task, 'status' | 'dueAt'>,
  now: Date,
): { text: string; tone: Tone } {
  const state = dueState(task, now);
  const due = parseIso(task.dueAt);
  if (state === 'overdue') return { text: t('tasks.overdue'), tone: 'danger' };
  if (state === 'today') return { text: t('tasks.dueToday'), tone: 'warning' };
  if (due === null) return { text: t('tasks.noDueDate'), tone: 'neutral' };
  return { text: t('tasks.due', { date: formatDateTime(due) }), tone: 'neutral' };
}

/** One task in a list: the whole card opens the task. */
export function TaskRow({
  task,
  now,
  onPress,
}: Readonly<{ task: Task; now: Date; onPress: () => void }>) {
  const due = dueLabel(task, now);
  const status = t(`tasks.status.${task.status}`);
  const urgent = task.priority === 'high' || task.priority === 'urgent';
  const dueDate = parseIso(task.dueAt);
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={[
        task.title,
        status,
        due.text,
        urgent ? t(`tasks.priority.${task.priority}`) : null,
      ]
        .filter(Boolean)
        .join(', ')}
    >
      <View style={styles.top}>
        <AppText variant="bodyStrong" style={styles.title} numberOfLines={2}>
          {task.title}
        </AppText>
        <Ionicons
          name="chevron-forward"
          size={iconSize.sm}
          color={colors.textMuted}
          style={styles.chevron}
        />
      </View>
      <View style={styles.badges}>
        <Badge label={status} tone={TASK_STATUS_TONES[task.status]} />
        {due.tone !== 'neutral' ? <Badge label={due.text} tone={due.tone} /> : null}
        {urgent ? <Badge label={t(`tasks.priority.${task.priority}`)} tone="warning" /> : null}
      </View>
      {due.tone === 'neutral' && dueDate !== null ? (
        <AppText variant="muted">{due.text}</AppText>
      ) : null}
    </Card>
  );
}

/** One work log in a list. */
export function LogRow({
  log,
  typeName,
  pendingPhotos = 0,
  onPress,
}: Readonly<{
  log: WorkLog;
  typeName: string | null;
  pendingPhotos?: number;
  onPress: () => void;
}>) {
  const occurred = parseIso(log.occurredAt);
  const title = typeName ?? t('logs.generalNote');
  const status = t(`logs.status.${log.status}`);
  const when = occurred ? formatDateTime(occurred) : '';
  return (
    <Card onPress={onPress} accessibilityLabel={[title, when, status].join(', ')}>
      <View style={styles.top}>
        <AppText variant="bodyStrong" style={styles.title} numberOfLines={1}>
          {title}
        </AppText>
        <Ionicons
          name="chevron-forward"
          size={iconSize.sm}
          color={colors.textMuted}
          style={styles.chevron}
        />
      </View>
      <AppText variant="muted">{when}</AppText>
      {log.text ? (
        <AppText variant="secondary" numberOfLines={2}>
          {log.text}
        </AppText>
      ) : null}
      <View style={styles.badges}>
        <Badge label={status} tone={LOG_STATUS_TONES[log.status]} />
        {pendingPhotos > 0 ? <Badge label={t('logs.uploads.title')} tone="warning" /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  top: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  title: {
    flex: 1,
  },
  chevron: {
    marginTop: spacing.xs / 2,
    // The arrow points forward in the reading direction (mirrored right to left).
    transform: [{ scaleX: I18nManager.isRTL ? -1 : 1 }],
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
