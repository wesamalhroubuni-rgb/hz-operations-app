import { colors, radii, spacing } from '@ops/shared';
import { Image, StyleSheet, View } from 'react-native';

import type { QueuedPhoto } from '../data/uploadQueue';
import { t } from '../i18n';
import { AppText } from './AppText';
import { Button } from './Button';
import { thumbnailSize } from './sizes';

function statusText(item: QueuedPhoto): string {
  switch (item.status) {
    case 'uploading':
      return t('logs.uploads.uploading', { percent: Math.round(item.progress * 100) });
    case 'waiting':
      return t('logs.uploads.waiting');
    case 'retrying':
      return t('logs.uploads.retrying');
    case 'failed':
      return `${t('logs.uploads.failed')}. ${t(`logs.uploads.errors.${item.error ?? 'unexpected'}`)}`;
  }
}

/** Photos of a saved log that are still on their way, with progress, retry and remove. */
export function UploadList({
  items,
  onRetry,
  onDiscard,
}: Readonly<{
  items: readonly QueuedPhoto[];
  onRetry: () => void;
  onDiscard: (localId: string) => void;
}>) {
  if (items.length === 0) return null;
  const anyFailed = items.some((item) => item.status === 'failed' || item.status === 'retrying');
  return (
    <View style={styles.box}>
      <AppText variant="heading">{t('logs.uploads.title')}</AppText>
      {items.map((item) => (
        <View key={item.photo.localId} style={styles.row}>
          <Image source={{ uri: item.photo.uri }} style={styles.thumb} resizeMode="cover" />
          <View style={styles.info}>
            <AppText
              variant={item.status === 'failed' ? 'bodyStrong' : 'secondary'}
              style={item.status === 'failed' ? styles.failed : undefined}
              accessibilityLiveRegion="polite"
            >
              {statusText(item)}
            </AppText>
            {item.status === 'uploading' ? (
              <View
                style={styles.track}
                accessible
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(item.progress * 100) }}
              >
                <View style={[styles.bar, { width: `${Math.round(item.progress * 100)}%` }]} />
              </View>
            ) : null}
            {item.status === 'failed' ? (
              <Button
                variant="link"
                label={t('logs.uploads.discard')}
                onPress={() => onDiscard(item.photo.localId)}
              />
            ) : null}
          </View>
        </View>
      ))}
      {anyFailed ? (
        <Button icon="refresh" label={t('logs.uploads.retry')} onPress={onRetry} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: spacing.md,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
  },
  thumb: {
    width: thumbnailSize / 1.5,
    height: thumbnailSize / 1.5,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceRaised,
  },
  info: {
    flex: 1,
    gap: spacing.xs,
  },
  failed: {
    color: colors.danger,
  },
  track: {
    height: spacing.sm,
    overflow: 'hidden',
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
  },
  bar: {
    height: '100%',
    backgroundColor: colors.primary,
  },
});
