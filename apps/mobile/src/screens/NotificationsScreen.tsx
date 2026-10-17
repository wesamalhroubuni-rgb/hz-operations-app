import { colors, radii, spacing } from '@ops/shared';
import { useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Message } from '../components/Message';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { useRepositories } from '../data/DataProvider';
import { useNotifications } from '../data/queries';
import type { WriteError } from '../data/results';
import { useOpenNotification } from '../hooks/useOpenNotification';
import { formatDateTime, t } from '../i18n';
import { errorText } from '../i18n/errorText';
import { parseIso } from '../logic/dates';
import { sortNotifications } from '../logic/notificationRouting';

/** The in-app notification list. Works without push (Expo Go). */
export function NotificationsScreen() {
  const query = useNotifications();
  const repositories = useRepositories();
  const open = useOpenNotification();
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<WriteError | null>(null);

  async function markAllRead(): Promise<void> {
    setMarkingAll(true);
    setError(null);
    const result = await repositories.notifications.markAllRead();
    setMarkingAll(false);
    if (!result.ok) setError(result.error);
  }

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;

  const items = sortNotifications(query.data.items);
  const unreadCount = query.data.unreadCount;

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          unreadCount > 0 || error ? (
            <View style={styles.header}>
              {error ? <Message tone="error" text={errorText(error)} /> : null}
              {unreadCount > 0 ? (
                <Button
                  variant="secondary"
                  icon="checkmark-done-outline"
                  label={t('notifications.markAllRead')}
                  busy={markingAll}
                  onPress={() => void markAllRead()}
                />
              ) : null}
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const unread = item.readAt === null;
          const created = parseIso(item.createdAt);
          return (
            <Card
              onPress={() => open(item)}
              accessibilityLabel={[
                unread ? t('notifications.unreadLabel', { title: item.title }) : item.title,
                item.body,
                created ? formatDateTime(created) : '',
              ].join(', ')}
              style={unread ? styles.unreadCard : undefined}
            >
              <View style={styles.titleRow}>
                {unread ? <View style={styles.dot} /> : null}
                <AppText variant={unread ? 'bodyStrong' : 'body'} style={styles.title}>
                  {item.title}
                </AppText>
              </View>
              <AppText variant="secondary">{item.body}</AppText>
              {created ? <AppText variant="muted">{formatDateTime(created)}</AppText> : null}
            </Card>
          );
        }}
        ListEmptyComponent={
          <EmptyState icon="notifications-off-outline" message={t('notifications.empty')} />
        }
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
      />
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
  header: {
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  unreadCard: {
    borderColor: colors.borderStrong,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dot: {
    width: spacing.md,
    height: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
  },
  title: {
    flex: 1,
  },
});
