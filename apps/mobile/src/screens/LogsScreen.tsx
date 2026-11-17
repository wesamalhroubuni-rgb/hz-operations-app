import { spacing } from '@ops/shared';
import { useMemo } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { Button } from '../components/Button';
import { LogRow } from '../components/rows';
import { EmptyState, LoadingState } from '../components/StateViews';
import { SyncReadErrorState } from '../components/SyncNotices';
import { SyncBanner } from '../components/SyncBanner';
import { useSync } from '../components/SyncProvider';
import { readErrorKind, useMyLogs } from '../data/queries';
import { useLookups } from '../hooks/useLookups';
import { useServerRefresh } from '../hooks/useServerRefresh';
import { usePendingPhotoCounts } from '../hooks/useUploads';
import { t } from '../i18n';
import { logSyncState } from '../logic/sync';
import type { TabScreenProps } from '../navigation/types';
import { makeStyles, useTheme } from '../theme';

/** My logs, newest first, with their review status. */
export function LogsScreen({ navigation }: Readonly<TabScreenProps<'Logs'>>) {
  const styles = useStyles();
  const { colors } = useTheme();
  const logs = useMyLogs();
  const server = useServerRefresh();
  const lookups = useLookups();
  const pendingPhotos = usePendingPhotoCounts();
  const { logStates } = useSync();
  const items = useMemo(() => logs.data?.pages.flatMap((page) => page.items) ?? [], [logs.data]);

  return (
    <View style={styles.screen}>
      <SyncBanner padded />
      {logs.isPending ? (
        <LoadingState />
      ) : logs.isError ? (
        <SyncReadErrorState kind={readErrorKind(logs.error)} onRetry={() => void logs.refetch()} />
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
              syncState={logSyncState(logStates, item.clientId)}
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
  },
}));
