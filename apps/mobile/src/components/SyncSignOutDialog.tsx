import { colors, radii, spacing } from '@ops/shared';
import { Alert, Modal, StyleSheet, View } from 'react-native';

import { t } from '../i18n';
import { KEPT_QUEUE_MAX_DAYS, type SignOutChoice } from '../offline/types';
import { AppText } from './AppText';
import { Button } from './Button';
import { Message } from './Message';

/**
 * Asked at sign-out when changes are still on the phone (ADR-0008, section 8): sync first, keep
 * them for the next sign-in, or discard them (confirmed once more), or cancel.
 */
export function SyncSignOutDialog({
  visible,
  pendingCount,
  stillPending,
  busy,
  onChoose,
  onCancel,
}: Readonly<{
  visible: boolean;
  pendingCount: number;
  /** After a "Sync first" that could not send everything: how many are left. */
  stillPending: number | null;
  busy: boolean;
  onChoose: (choice: SignOutChoice) => void;
  onCancel: () => void;
}>) {
  const confirmDiscard = () =>
    Alert.alert(t('sync.signOut.discardConfirmTitle'), t('sync.signOut.discardConfirmMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('sync.signOut.discard'),
        style: 'destructive',
        onPress: () => onChoose('discard'),
      },
    ]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <AppText variant="heading">{t('sync.signOut.title')}</AppText>
          <AppText variant="secondary">
            {t('sync.signOut.message', { count: pendingCount })}
          </AppText>
          {stillPending !== null ? (
            <Message tone="notice" text={t('sync.signOut.stillPending', { count: stillPending })} />
          ) : null}
          <Button
            icon="sync-outline"
            label={busy ? t('sync.syncing') : t('sync.signOut.syncFirst')}
            busy={busy}
            onPress={() => onChoose('syncFirst')}
          />
          <Button
            variant="secondary"
            label={t('sync.signOut.keepForLater')}
            disabled={busy}
            onPress={() => onChoose('keepForLater')}
            accessibilityHint={t('sync.signOut.keepForLaterHint', { days: KEPT_QUEUE_MAX_DAYS })}
          />
          <AppText variant="muted">
            {t('sync.signOut.keepForLaterHint', { days: KEPT_QUEUE_MAX_DAYS })}
          </AppText>
          <Button
            variant="secondary"
            icon="trash-outline"
            label={t('sync.signOut.discard')}
            disabled={busy}
            onPress={confirmDiscard}
          />
          <Button variant="link" label={t('common.cancel')} disabled={busy} onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  dialog: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
});
