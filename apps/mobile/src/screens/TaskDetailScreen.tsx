import { spacing, type TaskStatus } from '@ops/shared';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Button, type IconName } from '../components/Button';
import { Card } from '../components/Card';
import { TextField } from '../components/FormField';
import { InfoRow } from '../components/InfoRow';
import { Message } from '../components/Message';
import { dueLabel, TASK_STATUS_TONES } from '../components/rows';
import { ScreenContainer } from '../components/ScreenContainer';
import { ErrorState, LoadingState } from '../components/StateViews';
import { useData } from '../data/DataProvider';
import { readErrorKind, useTask } from '../data/queries';
import { useLookups } from '../hooks/useLookups';
import { useNow } from '../hooks/useNow';
import { useTaskStatusChange } from '../hooks/useTaskStatusChange';
import { t } from '../i18n';
import { errorText } from '../i18n/errorText';
import { assigneeStatusActions } from '../logic/tasks';
import type { StackScreenProps } from '../navigation/types';

const ACTION_ICONS: Record<TaskStatus, IconName> = {
  todo: 'arrow-undo-outline',
  in_progress: 'play-outline',
  blocked: 'hand-left-outline',
  done: 'checkmark-done-outline',
  cancelled: 'close-outline',
};

/** One task: what it is, its status, the moves the worker may make, and "Log work". */
export function TaskDetailScreen({ route, navigation }: Readonly<StackScreenProps<'TaskDetail'>>) {
  const { taskId } = route.params;
  const { user } = useData();
  const now = useNow();
  const query = useTask(taskId);
  const lookups = useLookups();
  const task = query.data;
  const change = useTaskStatusChange(task);

  if (query.isPending) return <LoadingState />;
  if (query.isError || !task) {
    return (
      <ErrorState
        message={errorText(readErrorKind(query.error))}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const actions = assigneeStatusActions(task, user.id);
  const isAssignee = task.assigneeIds.includes(user.id);
  const due = dueLabel(task, now);

  return (
    <ScreenContainer
      refreshing={query.isRefetching}
      onRefresh={() => void query.refetch()}
      footer={
        task.status !== 'cancelled' ? (
          <Button
            size="large"
            icon="create-outline"
            label={t('tasks.logWork')}
            onPress={() => navigation.navigate('LogForm', { mode: 'new', taskId: task.id })}
          />
        ) : undefined
      }
    >
      <AppText variant="title">{task.title}</AppText>
      <View style={styles.badges}>
        <Badge label={t(`tasks.status.${task.status}`)} tone={TASK_STATUS_TONES[task.status]} />
        <Badge label={due.text} tone={due.tone} />
        <Badge
          label={t(`tasks.priority.${task.priority}`)}
          tone={task.priority === 'urgent' || task.priority === 'high' ? 'warning' : 'neutral'}
        />
      </View>

      {change.changedTo ? (
        <Message
          tone="success"
          text={t('tasks.statusChanged', { status: t(`tasks.status.${change.changedTo}`) })}
        />
      ) : null}
      {change.error ? <Message tone="error" text={errorText(change.error)} /> : null}

      <Card>
        <InfoRow label={t('tasks.reason')} value={task.statusReason} />
        <InfoRow label={t('tasks.description')} value={task.description} />
        <InfoRow label={t('tasks.site')} value={lookups.siteName(task.siteId)} />
        <InfoRow label={t('tasks.team')} value={lookups.teamName(task.teamId)} />
      </Card>

      {task.status === 'cancelled' ? (
        <Message tone="notice" text={t('tasks.cancelledNote')} />
      ) : !isAssignee ? (
        <Message tone="notice" text={t('tasks.notAssigned')} />
      ) : (
        <View style={styles.actions}>
          <AppText variant="heading">{t('tasks.changeStatus')}</AppText>
          {change.askingReason ? (
            <Card>
              <TextField
                label={t('tasks.blockedReasonLabel')}
                value={change.reason}
                onValueChange={change.setReason}
                error={change.reasonMissing ? t('tasks.blockedReasonRequired') : undefined}
                multiline
                autoCapitalize="sentences"
                autoCorrect
                spellCheck
                autoFocus
                maxLength={1000}
              />
              <Button
                label={t('tasks.confirmBlocked')}
                icon={ACTION_ICONS.blocked}
                busy={change.busy === 'blocked'}
                onPress={change.confirmReason}
              />
              <Button
                variant="secondary"
                label={t('common.cancel')}
                onPress={change.cancelReason}
              />
            </Card>
          ) : (
            actions.map((status) => (
              <Button
                key={status}
                variant={status === 'done' ? 'primary' : 'secondary'}
                icon={ACTION_ICONS[status]}
                label={
                  status === 'blocked' && task.status === 'blocked'
                    ? t('tasks.updateBlockedReason')
                    : t(`tasks.actions.${status}`)
                }
                busy={change.busy === status}
                disabled={change.busy !== null}
                onPress={() => change.choose(status)}
              />
            ))
          )}
        </View>
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  actions: {
    gap: spacing.md,
  },
});
