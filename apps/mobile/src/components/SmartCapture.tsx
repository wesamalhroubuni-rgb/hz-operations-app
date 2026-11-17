import { Ionicons } from '@expo/vector-icons';
import { radii, spacing } from '@ops/shared';
import { Pressable, View } from 'react-native';

import type { CaptureView } from '../data/queries';
import { formatDateTime, t, type TranslationKey } from '../i18n';
import { syncText } from '../i18n/syncText';
import { captureState, transcriptOf, type CaptureState } from '../logic/smartCapture';
import { reasonText } from '../logic/sync';
import { makeStyles, useTheme } from '../theme';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Button, type IconName } from './Button';
import { Card } from './Card';
import { iconSize } from './sizes';

// Smart capture pieces (Phase 7, ADR-0010). Whatever the AI produced (transcripts, proposals) is
// rendered as plain text, never as markup or links.

export type CaptureKind = 'voice' | 'photo' | 'text';

const CAPTURE_TILES: readonly {
  kind: CaptureKind;
  icon: IconName;
  label: TranslationKey;
  hint: TranslationKey;
}[] = [
  { kind: 'voice', icon: 'mic-outline', label: 'capture.speak', hint: 'capture.speakHint' },
  { kind: 'photo', icon: 'camera-outline', label: 'capture.snap', hint: 'capture.snapHint' },
  { kind: 'text', icon: 'create-outline', label: 'capture.type', hint: 'capture.typeHint' },
];

/**
 * "Speak", "Snap" and "Type a note" as one card of three equal tiles (icon above a one-line
 * label). Shown only when the organization switched smart capture on.
 */
export function SmartCaptureButtons({ onPick }: Readonly<{ onPick: (kind: CaptureKind) => void }>) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Card>
      <View style={styles.row}>
        <Ionicons name="sparkles-outline" size={iconSize.sm} color={colors.primary} />
        <AppText variant="bodyStrong" style={styles.flex}>
          {t('capture.quickTitle')}
        </AppText>
      </View>
      <AppText variant="small">{t('capture.quickHint')}</AppText>
      <View style={styles.tiles}>
        {CAPTURE_TILES.map((tile) => (
          <Pressable
            key={tile.kind}
            accessibilityRole="button"
            accessibilityLabel={t(tile.label)}
            accessibilityHint={t(tile.hint)}
            onPress={() => onPick(tile.kind)}
            style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
          >
            <View style={[styles.tileIcon, { backgroundColor: `${colors.primary}1F` }]}>
              <Ionicons name={tile.icon} size={iconSize.md} color={colors.primary} />
            </View>
            <AppText
              variant="label"
              style={styles.tileLabel}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
            >
              {t(tile.label)}
            </AppText>
          </Pressable>
        ))}
      </View>
    </Card>
  );
}

/** The sentence of a capture's state. */
export function captureStatusText(state: CaptureState): string {
  switch (state.kind) {
    case 'ready':
      return t('capture.status.ready');
    case 'notUnderstood':
      return t('capture.status.notUnderstood');
    case 'waiting':
      return state.retrying ? t('capture.status.retrying') : t('capture.status.waiting');
    case 'notProcessed': {
      const reason = state.reason
        ? reasonText({ mutation: PLACEHOLDER, lastError: state.reason })
        : null;
      return reason
        ? t('capture.status.notProcessed', { reason: syncText(reason) })
        : t('capture.status.notProcessedNoReason');
    }
  }
}

// `reasonText` only reads the mutation for task-specific wording; a capture has none.
const PLACEHOLDER = { kind: 'discardSmartCapture', captureClientId: '', captureId: '' } as const;

const KIND_ICON_LABEL: Record<CaptureKind, TranslationKey> = {
  voice: 'capture.kinds.voice',
  photo: 'capture.kinds.photo',
  text: 'capture.kinds.text',
};

/** One capture in a list: kind, time, state, the worker's words. Tapping opens the review. */
export function CaptureRow({
  view,
  onPress,
}: Readonly<{ view: CaptureView; onPress: () => void }>) {
  const styles = useStyles();
  const state = captureState(view.local, view.item);
  const words = transcriptOf(view.local);
  return (
    <Card onPress={onPress} accessibilityLabel={t(KIND_ICON_LABEL[view.local.input.kind])}>
      <View style={styles.row}>
        <AppText variant="bodyStrong" style={styles.flex}>
          {t(KIND_ICON_LABEL[view.local.input.kind])}
        </AppText>
        {state.kind === 'ready' ? <Badge label={t('capture.aiSuggested')} tone="primary" /> : null}
      </View>
      <AppText variant="muted">{formatDateTime(new Date(view.local.context.capturedAt))}</AppText>
      {words ? (
        <AppText variant="secondary" numberOfLines={2}>
          {words}
        </AppText>
      ) : null}
      <AppText variant="small" style={state.kind === 'ready' ? styles.ready : undefined}>
        {captureStatusText(state)}
      </AppText>
    </Card>
  );
}

/** The clear marker of a form filled by the AI. */
export function AiSuggestedBanner() {
  const styles = useStyles();
  return (
    <Card style={styles.banner}>
      <View style={styles.row}>
        <Badge label={t('capture.aiSuggested')} tone="primary" />
      </View>
      <AppText variant="secondary">{t('capture.aiSuggestedHint')}</AppText>
    </Card>
  );
}

/** What the worker said, typed or noted, as plain text, with the discard action. */
export function TranscriptPanel({
  view,
  onDiscard,
}: Readonly<{ view: CaptureView; onDiscard: () => void }>) {
  const words = transcriptOf(view.local);
  const title: TranslationKey =
    view.local.input.kind === 'voice'
      ? 'capture.transcriptTitle'
      : view.local.input.kind === 'photo'
        ? 'capture.noteTitle'
        : 'capture.textTitle';
  return (
    <Card>
      <AppText variant="heading">{t(title)}</AppText>
      <AppText selectable>{words ?? t('capture.noTranscript')}</AppText>
      <AppText variant="small">{captureStatusText(captureState(view.local, view.item))}</AppText>
      <Button variant="link" label={t('capture.discard')} onPress={onDiscard} />
    </Card>
  );
}

/** The confidence hint under a field that still holds the AI's suggestion. */
export function ConfidenceHint({
  level,
}: Readonly<{ level: 'high' | 'medium' | 'low' | undefined }>) {
  const styles = useStyles();
  if (!level) return null;
  return (
    <AppText variant="small" style={level === 'high' ? styles.ready : styles.check}>
      {t(`capture.confidence.${level}`)}
    </AppText>
  );
}

const useStyles = makeStyles((colors) => ({
  flex: {
    flex: 1,
  },
  tiles: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  tile: {
    flex: 1,
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  tilePressed: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceRaised,
  },
  tileIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  tileLabel: {
    color: colors.textPrimary,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  banner: {
    borderColor: colors.primary,
  },
  ready: {
    color: colors.success,
  },
  check: {
    color: colors.warning,
  },
}));
