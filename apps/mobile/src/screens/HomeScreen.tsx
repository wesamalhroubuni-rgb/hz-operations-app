import { spacing } from '@ops/shared';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { LogRow, TaskRow } from '../components/rows';
import { ScreenContainer } from '../components/ScreenContainer';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { useData } from '../data/DataProvider';
import { useMyLogs, useMyTasks } from '../data/queries';
import { useLookups } from '../hooks/useLookups';
import { useNow } from '../hooks/useNow';
import { usePendingPhotoCounts } from '../hooks/useUploads';
import { t } from '../i18n';
import { tasksForToday } from '../logic/tasks';
import type { TabScreenProps } from '../navigation/types';

const RECENT_LOGS = 3;

/**
 * Today at a glance: what is due today or overdue, the latest logs, and the big "New log" button
 * at the bottom where the thumb is.
 */
export function HomeScreen({ navigation }: Readonly<TabScreenProps<'Home'>>) {
  const { user } = useData();
  const now = useNow();
  const tasks = useMyTasks();
  const logs = useMyLogs();
  const lookups = useLookups();
  const pendingPhotos = usePendingPhotoCounts();

  const today = tasksForToday(tasks.data ?? [], now);
  const recent = logs.data?.pages[0]?.items.slice(0, RECENT_LOGS) ?? [];

  return (
    <ScreenContainer
      inTab
      refreshing={tasks.isRefetching || logs.isRefetching}
      onRefresh={() => {
        void tasks.refetch();
        void logs.refetch();
      }}
      footer={
        <Button
          size="large"
          icon="add-circle-outline"
          label={t('home.newLog')}
          accessibilityHint={t('home.newLogHint')}
          onPress={() => navigation.navigate('LogForm', { mode: 'new' })}
        />
      }
    >
      <AppText variant="title">{t('home.greeting', { name: user.displayName })}</AppText>

      <View style={styles.section}>
        <AppText variant="heading">{t('home.todayTitle')}</AppText>
        {tasks.isPending ? (
          <LoadingState />
        ) : tasks.isError ? (
          <ErrorState onRetry={() => void tasks.refetch()} />
        ) : today.length === 0 ? (
          <EmptyState icon="checkmark-done-outline" message={t('home.nothingToday')} />
        ) : (
          today.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              now={now}
              onPress={() => navigation.navigate('TaskDetail', { taskId: task.id })}
            />
          ))
        )}
        <Button
          variant="link"
          label={t('home.allTasks')}
          onPress={() => navigation.navigate('Tasks')}
        />
      </View>

      <View style={styles.section}>
        <AppText variant="heading">{t('home.recentLogsTitle')}</AppText>
        {logs.isPending ? (
          <LoadingState />
        ) : logs.isError ? (
          <ErrorState onRetry={() => void logs.refetch()} />
        ) : recent.length === 0 ? (
          <EmptyState icon="create-outline" message={t('home.noLogs')} />
        ) : (
          recent.map((log) => (
            <LogRow
              key={log.id}
              log={log}
              typeName={lookups.logTypeName(log.logTypeId)}
              pendingPhotos={pendingPhotos.get(log.id) ?? 0}
              onPress={() => navigation.navigate('LogDetail', { logId: log.id })}
            />
          ))
        )}
        {recent.length > 0 ? (
          <Button
            variant="link"
            label={t('home.allLogs')}
            onPress={() => navigation.navigate('Logs')}
          />
        ) : null}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.md,
  },
});
