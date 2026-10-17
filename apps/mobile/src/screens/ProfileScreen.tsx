import { spacing } from '@ops/shared';
import Constants from 'expo-constants';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { BrandHeader } from '../components/BrandHeader';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { InfoRow } from '../components/InfoRow';
import { Message } from '../components/Message';
import { ScreenContainer } from '../components/ScreenContainer';
import { useData } from '../data/DataProvider';
import { useSignOut } from '../hooks/useSignOut';
import { t } from '../i18n';
import { roleName } from '../i18n/roles';
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
  const { busy, failure, run } = useSignOut();
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
          onPress={() => void run('device')}
          disabled={busy !== null}
          busy={busy === 'device'}
        />
        <Button
          variant="secondary"
          label={busy === 'everywhere' ? t('auth.signingOut') : t('auth.signOutEverywhere')}
          onPress={() => void run('everywhere')}
          disabled={busy !== null}
          busy={busy === 'everywhere'}
          accessibilityHint={t('auth.signOutEverywhereHint')}
        />
        <AppText variant="muted">{t('auth.signOutEverywhereHint')}</AppText>
      </View>

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
