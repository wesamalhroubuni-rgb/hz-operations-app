import { fontSizes, fontWeights, spacing } from '@ops/shared';
import Constants from 'expo-constants';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Message } from '../components/Message';
import { ScreenContainer } from '../components/ScreenContainer';
import { useSync } from '../components/SyncProvider';
import { SyncSignOutDialog } from '../components/SyncSignOutDialog';
import { ThemeChoice } from '../components/ThemeChoice';
import { useAuth } from '../auth/AuthProvider';
import { brand } from '../config/brand';
import { useData } from '../data/DataProvider';
import { useServerRefresh } from '../hooks/useServerRefresh';
import type { SignOutScope } from '../hooks/useSignOut';
import { t } from '../i18n';
import { roleName } from '../i18n/roles';
import { afterSyncFirst } from '../logic/sync';
import { useSignOutWithChoice } from '../offline/engineIntegration';
import type { SignOutChoice } from '../offline/types';
import { usePushState } from '../push/usePush';
import type { PushState } from '../push/pushService';
import { useTheme } from '../theme';

function pushText(state: PushState): string {
  switch (state.status) {
    case 'on':
      return t('profile.push.on');
    case 'denied':
      return t('profile.push.denied');
    case 'unavailable':
      return state.reason === 'expoGo'
        ? t('profile.push.expoGo')
        : state.reason === 'simulator'
          ? t('profile.push.simulator')
          : t('profile.push.notConfigured');
    case 'failed':
      return t('profile.push.failed');
    case 'idle':
    case 'pending':
      return t('profile.push.pending');
  }
}

/** Up to two initials of a display name, for the avatar. */
function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters
    .map((word) => Array.from(word ?? '')[0] ?? '')
    .join('')
    .toUpperCase();
}

/** Who is signed in, push status, the theme, the two ways to sign out, and the app version. */
export function ProfileScreen() {
  const { user } = useData();
  const { refreshUser } = useAuth();
  // Pull to refresh asks the server who the user is now (a role or scope changed on the
  // dashboard), alongside a sync. It also happens by itself after the automatic pulls.
  const recheckUser = useCallback(() => refreshUser(), [refreshUser]);
  const server = useServerRefresh(recheckUser);
  const { busy, failure, run } = useSignOutWithChoice();
  const sync = useSync();
  // Sign-out with changes still on the phone asks first (ADR-0008, section 8).
  const [asking, setAsking] = useState<SignOutScope | null>(null);
  const [stillPending, setStillPending] = useState<number | null>(null);
  const [syncingFirst, setSyncingFirst] = useState(false);
  // What is not finished on the phone: queued writes and smart captures waiting for review.
  const [unfinished, setUnfinished] = useState({ writes: 0, captures: 0 });

  async function requestSignOut(scope: SignOutScope): Promise<void> {
    // Without a choice nothing changes while something is unfinished: the answer says what.
    const result = await run(scope, null);
    if (!result.ok && result.reason === 'needsChoice') {
      setUnfinished({ writes: result.pending - result.captures, captures: result.captures });
      setStillPending(null);
      setAsking(scope);
    }
  }

  async function choose(choice: SignOutChoice): Promise<void> {
    if (asking === null) return;
    const scope = asking;
    if (choice === 'syncFirst') {
      setSyncingFirst(true);
      try {
        const left = await sync.syncNow();
        if (afterSyncFirst(left) === 'stillPending') {
          setStillPending(left);
          return;
        }
      } finally {
        setSyncingFirst(false);
      }
    }
    setAsking(null);
    const result = await run(scope, choice);
    if (!result.ok && 'pending' in result) {
      const writes = result.pending - result.captures;
      setUnfinished({ writes, captures: result.captures });
      // Captures waiting for review are not "not sent": the dialog says so on its own line.
      setStillPending(writes > 0 ? writes : null);
      setAsking(scope);
    }
  }
  const push = usePushState();
  const { colors } = useTheme();
  const version = Constants.expoConfig?.version ?? '';

  return (
    <ScreenContainer inTab refreshing={server.refreshing} onRefresh={server.refresh}>
      <Card>
        <View style={styles.identity}>
          <View style={[styles.avatar, { backgroundColor: colors.brandInk }]}>
            <AppText style={[styles.initials, { color: colors.brandGold }]}>
              {initialsOf(user.displayName)}
            </AppText>
          </View>
          <View style={styles.flex}>
            <AppText variant="heading" numberOfLines={2}>
              {user.displayName}
            </AppText>
            <AppText variant="small" numberOfLines={1}>
              {user.organizationName}
            </AppText>
          </View>
          <Badge label={roleName(user.role)} tone="primary" />
        </View>
      </Card>

      <Card>
        <AppText variant="heading">{t('profile.push.title')}</AppText>
        <AppText variant="secondary">{pushText(push)}</AppText>
      </Card>

      <ThemeChoice />

      <View style={styles.actions}>
        {failure !== null ? <Message tone="error" text={failure} /> : null}
        <Button
          icon="log-out-outline"
          label={busy === 'device' ? t('auth.signingOut') : t('auth.signOut')}
          onPress={() => void requestSignOut('device')}
          disabled={busy !== null}
          busy={busy === 'device'}
        />
        <Button
          variant="secondary"
          label={busy === 'everywhere' ? t('auth.signingOut') : t('auth.signOutEverywhere')}
          onPress={() => void requestSignOut('everywhere')}
          disabled={busy !== null}
          busy={busy === 'everywhere'}
          accessibilityHint={t('auth.signOutEverywhereHint')}
        />
        <AppText variant="muted">{t('auth.signOutEverywhereHint')}</AppText>
      </View>

      <SyncSignOutDialog
        visible={asking !== null}
        pendingCount={unfinished.writes}
        captureCount={unfinished.captures}
        stillPending={stillPending}
        busy={syncingFirst}
        onChoose={(choice) => void choose(choice)}
        onCancel={() => setAsking(null)}
      />

      <AppText variant="muted" style={styles.about}>
        {brand.appLabel} · {t('profile.version', { version })}
      </AppText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing.md,
  },
  about: {
    paddingTop: spacing.md,
    textAlign: 'center',
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  flex: {
    flex: 1,
    gap: 2,
  },
  avatar: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 26,
  },
  initials: {
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.bold,
  },
});
