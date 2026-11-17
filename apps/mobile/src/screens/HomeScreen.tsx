import { spacing } from '@ops/shared';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { BrandBand } from '../components/BrandBand';
import { Button } from '../components/Button';
import { LogRow, TaskRow } from '../components/rows';
import { ScreenContainer } from '../components/ScreenContainer';
import { SectionHeader } from '../components/SectionHeader';
import { CaptureRow, SmartCaptureButtons } from '../components/SmartCapture';
import { EmptyState, LoadingState } from '../components/StateViews';
import { SyncReadErrorState } from '../components/SyncNotices';
import { SyncBanner } from '../components/SyncBanner';
import { SyncIndicator } from '../components/SyncIndicator';
import { useSync } from '../components/SyncProvider';
import { brand } from '../config/brand';
import { useData } from '../data/DataProvider';
import {
  readErrorKind,
  useMyLogs,
  useMyTasks,
  useSmartCaptureEnabled,
  useSmartCaptures,
} from '../data/queries';
import { useLookups } from '../hooks/useLookups';
import { useNow } from '../hooks/useNow';
import { useServerRefresh } from '../hooks/useServerRefresh';
import { usePendingPhotoCounts } from '../hooks/useUploads';
import { formatDate, t } from '../i18n';
import { logSyncState } from '../logic/sync';
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
  const { logStates } = useSync();
  const smartCapture = useSmartCaptureEnabled();
  const captures = useSmartCaptures();
  const server = useServerRefresh();

  const today = tasksForToday(tasks.data ?? [], now);
  const recent = logs.data?.pages[0]?.items.slice(0, RECENT_LOGS) ?? [];

  return (
    <View style={styles.screen}>
      <BrandBand
        safeTop
        title={user.organizationName}
        subtitle={brand.appLabel}
        end={<SyncIndicator onBrand />}
      />
      <ScreenContainer
        inTab
        refreshing={server.refreshing}
        onRefresh={server.refresh}
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
        <SyncBanner />
        <View style={styles.greeting}>
          <AppText variant="title">
            {t('home.greeting', { name: firstName(user.displayName) })}
          </AppText>
          <AppText variant="muted">{formatDate(now)}</AppText>
        </View>

        {smartCapture ? (
          <SmartCaptureButtons onPick={(kind) => navigation.navigate('Capture', { kind })} />
        ) : null}

        {/* Captures stay listed until reviewed or discarded, even if the switch went off since. */}
        {(captures.data?.length ?? 0) > 0 ? (
          <View style={styles.section}>
            <SectionHeader title={t('capture.listTitle')} />
            {(captures.data ?? []).map((view) => (
              <CaptureRow
                key={view.local.captureClientId}
                view={view}
                onPress={() =>
                  navigation.navigate('LogForm', {
                    mode: 'new',
                    captureClientId: view.local.captureClientId,
                  })
                }
              />
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionHeader
            title={t('home.todayTitle')}
            actionLabel={t('home.seeAll')}
            onAction={() => navigation.navigate('Tasks')}
          />
          {tasks.isPending ? (
            <LoadingState />
          ) : tasks.isError ? (
            <SyncReadErrorState
              kind={readErrorKind(tasks.error)}
              onRetry={() => void tasks.refetch()}
            />
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
        </View>

        <View style={styles.section}>
          <SectionHeader
            title={t('home.recentLogsTitle')}
            actionLabel={recent.length > 0 ? t('home.seeAll') : undefined}
            onAction={() => navigation.navigate('Logs')}
          />
          {logs.isPending ? (
            <LoadingState />
          ) : logs.isError ? (
            <SyncReadErrorState
              kind={readErrorKind(logs.error)}
              onRetry={() => void logs.refetch()}
            />
          ) : recent.length === 0 ? (
            <EmptyState icon="create-outline" message={t('home.noLogs')} />
          ) : (
            recent.map((log) => (
              <LogRow
                key={log.id}
                log={log}
                typeName={lookups.logTypeName(log.logTypeId)}
                pendingPhotos={pendingPhotos.get(log.id) ?? 0}
                syncState={logSyncState(logStates, log.clientId)}
                onPress={() => navigation.navigate('LogDetail', { logId: log.id })}
              />
            ))
          )}
        </View>
      </ScreenContainer>
    </View>
  );
}

/** The first word of a display name, for a friendly greeting. */
function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  greeting: {
    gap: spacing.xs,
  },
  section: {
    gap: spacing.md,
  },
});
