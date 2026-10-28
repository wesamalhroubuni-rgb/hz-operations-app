import { spacing } from '@ops/shared';
import Constants from 'expo-constants';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { BrandHeader } from '../components/BrandHeader';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { InfoRow } from '../components/InfoRow';
import { Message } from '../components/Message';
import { ScreenContainer } from '../components/ScreenContainer';
import { useSync } from '../components/SyncProvider';
import { SyncSignOutDialog } from '../components/SyncSignOutDialog';
import { useData } from '../data/DataProvider';
import type { SignOutScope } from '../hooks/useSignOut';
import { t } from '../i18n';
import { roleName } from '../i18n/roles';
import { afterSyncFirst, signOutStep } from '../logic/sync';
import { useSignOutWithChoice } from '../offline/engineIntegration';
import type { SignOutChoice } from '../offline/types';
import { usePushState } from '../push/usePush';
import type { PushState } from '../push/pushService';

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

/** Who is signed in, push status, the two ways to sign out, and the app version. */
export function ProfileScreen() {
  const { user } = useData();
  const { busy, failure, run } = useSignOutWithChoice();
  const sync = useSync();
  // Sign-out with changes still on the phone asks first (ADR-0008, section 8).
  const [asking, setAsking] = useState<SignOutScope | null>(null);
  const [stillPending, setStillPending] = useState<number | null>(null);
  const [syncingFirst, setSyncingFirst] = useState(false);

  async function requestSignOut(scope: SignOutScope): Promise<void> {
    if (sync.available && signOutStep(sync.pendingCount) === 'ask') {
      setStillPending(null);
      setAsking(scope);
      return;
    }
    const result = await run(scope, null);
    if (!result.ok && result.reason === 'needsChoice') setAsking(scope);
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
      setStillPending(result.pending);
      setAsking(scope);
    }
  }
  const push = usePushState();
  const version = Constants.expoConfig?.version ?? '';

  return (
    <ScreenContainer inTab>
      <Card>
        <AppText variant="label">{t('profile.signedInAs')}</AppText>
        <AppText variant="title">{user.displayName}</AppText>
        <Badge label={roleName(user.role)} tone="primary" />
        <InfoRow label={t('profile.organization')} value={user.organizationName} />
        <InfoRow label={t('profile.role')} value={roleName(user.role)} />
      </Card>

      <Card>
        <AppText variant="heading">{t('profile.push.title')}</AppText>
        <AppText variant="secondary">{pushText(push)}</AppText>
      </Card>

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
        pendingCount={sync.pendingCount}
        stillPending={stillPending}
        busy={syncingFirst}
        onChoose={(choice) => void choose(choice)}
        onCancel={() => setAsking(null)}
      />

      <View style={styles.about}>
        <BrandHeader compact />
        <AppText variant="muted" style={styles.center}>
          {t('profile.version', { version })}
        </AppText>
        <AppText variant="muted" style={styles.center}>
          {t('common.poweredBy')}
        </AppText>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing.md,
  },
  about: {
    gap: spacing.sm,
    alignItems: 'center',
    paddingTop: spacing.lg,
  },
  center: {
    textAlign: 'center',
  },
});
