import { spacing } from '@ops/shared';
import { useState } from 'react';
import { Alert, Share, StyleSheet, View } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { AppText } from '../components/AppText';
import { Badge, type Tone } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Message } from '../components/Message';
import { ScreenContainer } from '../components/ScreenContainer';
import { EmptyState } from '../components/StateViews';
import { SyncPhotoStorageNotice, useLastRefreshedLabel } from '../components/SyncBanner';
import { useSync } from '../components/SyncProvider';
import { formatDateTime, t } from '../i18n';
import { syncText } from '../i18n/syncText';
import {
  bannerFor,
  groupItems,
  itemActions,
  itemSummary,
  itemTitle,
  reasonText,
  statusPresentation,
} from '../logic/sync';
import { parseIso } from '../logic/dates';
import { useRequestSignIn } from '../offline/engineIntegration';
import type { QueueItem, QueueItemState } from '../offline/types';

const STATE_TONES: Record<Exclude<QueueItemState, 'done'>, Tone> = {
  pending: 'neutral',
  sending: 'info',
  failed_retryable: 'warning',
  failed_permanent: 'danger',
};

function ItemCard({ item }: Readonly<{ item: QueueItem }>) {
  const sync = useSync();
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const actions = itemActions(item);
  const reason = reasonText(item);
  const summary = itemSummary(item);
  const made = parseIso(item.createdAt);
  const next = item.state === 'failed_retryable' ? parseIso(item.nextAttemptAt) : null;

  async function act(action: () => Promise<void>, done?: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (done) setNotice({ tone: 'success', text: done });
    } catch {
      setNotice({ tone: 'error', text: t('sync.actionFailed') });
    } finally {
      setBusy(false);
    }
  }

  const confirmDiscard = () =>
    Alert.alert(t('sync.discardTitle'), t('sync.discardMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('sync.actions.discard'),
        style: 'destructive',
        onPress: () => void act(() => sync.discard(item.id)),
      },
    ]);

  return (
    <Card>
      <AppText variant="bodyStrong">{syncText(itemTitle(item))}</AppText>
      {summary ? (
        <AppText variant="secondary" numberOfLines={2}>
          {summary}
        </AppText>
      ) : null}
      {item.state !== 'done' ? (
        <Badge label={t(`sync.states.${item.state}`)} tone={STATE_TONES[item.state]} />
      ) : null}
      {made ? (
        <AppText variant="muted">{t('sync.savedAt', { time: formatDateTime(made) })}</AppText>
      ) : null}
      {reason ? <AppText variant="secondary">{syncText(reason)}</AppText> : null}
      {item.attempts > 0 ? (
        <AppText variant="muted">
          {[
            t('sync.attempts', { count: item.attempts }),
            next ? t('sync.nextAttempt', { time: formatDateTime(next) }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </AppText>
      ) : null}
      {content !== null ? (
        <View style={styles.content}>
          <AppText selectable>{content}</AppText>
        </View>
      ) : null}
      {notice ? <Message tone={notice.tone} text={notice.text} /> : null}
      <View style={styles.actions}>
        {actions.retry ? (
          <Button
            icon="refresh"
            label={t('sync.actions.retry')}
            disabled={busy}
            onPress={() => void act(() => sync.retry(item.id))}
          />
        ) : null}
        {actions.view ? (
          <Button
            variant="secondary"
            icon="eye-outline"
            label={content === null ? t('sync.actions.view') : t('sync.actions.hide')}
            disabled={busy}
            onPress={() =>
              content === null
                ? void act(async () => setContent(await sync.copyText(item.id)))
                : setContent(null)
            }
          />
        ) : null}
        {actions.copy ? (
          <Button
            variant="secondary"
            icon="copy-outline"
            label={t('sync.actions.copy')}
            disabled={busy}
            onPress={() =>
              void act(async () => {
                // No clipboard module in this app: the share sheet offers "Copy".
                await Share.share({ message: await sync.copyText(item.id) });
              })
            }
          />
        ) : null}
        {actions.resubmit ? (
          <Button
            variant="secondary"
            icon="add-circle-outline"
            label={t('sync.actions.resubmit')}
            disabled={busy}
            onPress={() => void act(() => sync.resubmitAsNew(item.id), t('sync.resubmitted'))}
          />
        ) : null}
        {actions.discard ? (
          <Button
            variant="link"
            label={t('sync.actions.discard')}
            disabled={busy}
            onPress={confirmDiscard}
          />
        ) : null}
      </View>
    </Card>
  );
}

/**
 * What is on this phone and not yet accepted by the server: refused changes first (with their
 * reason and what the worker can do), then the ones waiting to be sent. "Sync now" at the bottom.
 */
export function SyncScreen() {
  const sync = useSync();
  const lastRefreshed = useLastRefreshedLabel();
  const requestSignIn = useRequestSignIn();
  const { offline: openedOffline } = useAuth();
  const { failed, waiting } = groupItems(sync.items);
  const status = sync.status;
  const banner = bannerFor(status, lastRefreshed, openedOffline);
  const busy = sync.syncing || status?.kind === 'syncing';

  return (
    <ScreenContainer
      footer={
        <Button
          size="large"
          icon="sync-outline"
          label={busy ? t('sync.syncing') : t('sync.syncNow')}
          busy={busy}
          disabled={!sync.available || status?.kind === 'offline'}
          onPress={() => void sync.syncNow()}
        />
      }
    >
      {status ? (
        <Card>
          <AppText variant="heading">{syncText(statusPresentation(status).text)}</AppText>
          <AppText variant="muted">
            {lastRefreshed
              ? t('sync.lastRefreshed', { time: lastRefreshed })
              : t('sync.neverRefreshed')}
          </AppText>
        </Card>
      ) : null}
      {banner ? (
        <Message tone={banner.tone} text={syncText(banner.text)}>
          {banner.signIn ? (
            <Button
              variant="secondary"
              icon="log-in-outline"
              label={t('sync.signInAgain')}
              onPress={requestSignIn}
            />
          ) : null}
        </Message>
      ) : null}
      <SyncPhotoStorageNotice />

      {failed.length === 0 && waiting.length === 0 ? (
        <EmptyState icon="cloud-done-outline" message={t('sync.empty')} />
      ) : null}

      {failed.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="heading">{t('sync.failedTitle')}</AppText>
          <AppText variant="secondary">{t('sync.failedIntro')}</AppText>
          {failed.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </View>
      ) : null}

      {waiting.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="heading">{t('sync.pendingTitle')}</AppText>
          {waiting.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </View>
      ) : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.md,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  content: {
    paddingTop: spacing.xs,
  },
});
