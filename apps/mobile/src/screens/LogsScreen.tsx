import { colors, spacing } from '@ops/shared';
import { useMemo } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { Button } from '../components/Button';
import { LogRow } from '../components/rows';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { useMyLogs } from '../data/queries';
import { useLookups } from '../hooks/useLookups';
import { usePendingPhotoCounts } from '../hooks/useUploads';
import { t } from '../i18n';
import type { TabScreenProps } from '../navigation/types';

/** My logs, newest first, with their review status. */
export function LogsScreen({ navigation }: Readonly<TabScreenProps<'Logs'>>) {
  const logs = useMyLogs();
  const lookups = useLookups();
  const pendingPhotos = usePendingPhotoCounts();
  const items = useMemo(() => logs.data?.pages.flatMap((page) => page.items) ?? [], [logs.data]);

  return (
    <View style={styles.screen}>
      {logs.isPending ? (
        <LoadingState />
      ) : logs.isError ? (
        <ErrorState onRetry={() => void logs.refetch()} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(log) => log.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <LogRow
              log={item}
              typeName={lookups.logTypeName(item.logTypeId)}
              pendingPhotos={pendingPhotos.get(item.id) ?? 0}
              onPress={() => navigation.navigate('LogDetail', { logId: item.id })}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="create-outline"
              message={t('logs.empty')}
              actionLabel={t('home.newLog')}
              onAction={() => navigation.navigate('LogForm', { mode: 'new' })}
            />
          }
          ListFooterComponent={
            logs.hasNextPage ? (
              <Button
                variant="secondary"
                label={t('common.showMore')}
                busy={logs.isFetchingNextPage}
                onPress={() => void logs.fetchNextPage()}
              />
            ) : null
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (logs.hasNextPage && !logs.isFetchingNextPage) void logs.fetchNextPage();
          }}
          refreshControl={
            <RefreshControl
              refreshing={logs.isRefetching && !logs.isFetchingNextPage}
              onRefresh={() => void logs.refetch()}
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

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  list: {
    gap: spacing.md,
    padding: spacing.lg,
  },
});
