import { spacing } from '@ops/shared';
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { FilterChips } from '../components/FilterChips';
import { TaskRow } from '../components/rows';
import { EmptyState, LoadingState } from '../components/StateViews';
import { SyncReadErrorState } from '../components/SyncNotices';
import { SyncBanner } from '../components/SyncBanner';
import { readErrorKind, useMyTasks } from '../data/queries';
import { useNow } from '../hooks/useNow';
import { useServerRefresh } from '../hooks/useServerRefresh';
import { t } from '../i18n';
import { countTasksByFilter, filterTasks, TASK_FILTERS, type TaskFilter } from '../logic/tasks';
import type { TabScreenProps } from '../navigation/types';
import { makeStyles, useTheme } from '../theme';

/** My tasks with the open / today / overdue / done filters. */
export function TasksScreen({ navigation }: Readonly<TabScreenProps<'Tasks'>>) {
  const styles = useStyles();
  const { colors } = useTheme();
  const now = useNow();
  const tasks = useMyTasks();
  const server = useServerRefresh();
  const [filter, setFilter] = useState<TaskFilter>('open');

  const all = useMemo(() => tasks.data ?? [], [tasks.data]);
  const counts = useMemo(() => countTasksByFilter(all, now), [all, now]);
  const shown = useMemo(() => filterTasks(all, filter, now), [all, filter, now]);

  const options = TASK_FILTERS.map((value) => ({
    value,
    label: t(`tasks.filters.${value}`),
    count: counts[value],
    accessibilityLabel: t('tasks.filterLabel', {
      filter: t(`tasks.filters.${value}`),
      count: counts[value],
    }),
  }));

  return (
    <View style={styles.screen}>
      <SyncBanner padded />
      <FilterChips options={options} value={filter} onChange={setFilter} />
      {tasks.isPending ? (
        <LoadingState />
      ) : tasks.isError ? (
        <SyncReadErrorState
          kind={readErrorKind(tasks.error)}
          onRetry={() => void tasks.refetch()}
        />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(task) => task.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TaskRow
              task={item}
              now={now}
              onPress={() => navigation.navigate('TaskDetail', { taskId: item.id })}
            />
          )}
          ListEmptyComponent={
            <EmptyState icon="checkmark-done-outline" message={t(`tasks.empty.${filter}`)} />
          }
          refreshControl={
            <RefreshControl
              refreshing={server.refreshing}
              onRefresh={server.refresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surface}
            />
          }
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  list: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingTop: spacing.sm,
  },
}));
