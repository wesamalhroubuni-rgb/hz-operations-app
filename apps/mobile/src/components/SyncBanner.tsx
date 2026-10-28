import { spacing } from '@ops/shared';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { useNow } from '../hooks/useNow';
import { formatDateTime, formatTime, t } from '../i18n';
import { syncText } from '../i18n/syncText';
import { bannerFor, photoStorageNotice, refreshedWhen } from '../logic/sync';
import { useRequestSignIn } from '../offline/engineIntegration';
import { Button } from './Button';
import { Message } from './Message';
import { useSync } from './SyncProvider';

/** "14:05" today, "16 Oct 2026, 14:05" before; null when never refreshed. */
export function useLastRefreshedLabel(): string | null {
  const { lastRefreshedAt } = useSync();
  const now = useNow();
  const when = refreshedWhen(lastRefreshedAt, now);
  if (when === 'never' || lastRefreshedAt === null) return null;
  const at = new Date(lastRefreshedAt);
  return when === 'today' ? formatTime(at) : formatDateTime(at);
}

/** The local photo storage warning (80%) or block (100%). Renders nothing below 80%. */
export function SyncPhotoStorageNotice() {
  const { photoUsage } = useSync();
  const notice = photoStorageNotice(photoUsage);
  if (notice === null) return null;
  return (
    <Message
      tone={notice.tone}
      text={t(notice.text.key, {
        used: t('sync.photoStorage.megabytes', { value: notice.usedMb }),
        limit: t('sync.photoStorage.megabytes', { value: notice.limitMb }),
      })}
    />
  );
}

/**
 * Above Home, Tasks and Logs: "offline, showing data from …", "sign in again" when the session
 * cannot be renewed, and the photo storage notice. Renders nothing when all is well.
 */
export function SyncBanner({ padded = false }: Readonly<{ padded?: boolean }>) {
  const { available, status, photoUsage } = useSync();
  const { offline: openedOffline } = useAuth();
  const lastRefreshed = useLastRefreshedLabel();
  const requestSignIn = useRequestSignIn();
  if (!available) return null;
  const banner = bannerFor(status, lastRefreshed, openedOffline);
  const storage = photoStorageNotice(photoUsage);
  if (banner === null && storage === null) return null;
  return (
    <View style={[styles.box, padded && styles.padded]}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: spacing.sm,
  },
  padded: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
});
