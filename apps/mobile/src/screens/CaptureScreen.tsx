import {
  AI_CAPTURE_MAX_AUDIO_MS,
  AI_CAPTURE_MAX_PHOTO_NOTE_LENGTH,
  AI_CAPTURE_MAX_TEXT_LENGTH,
  spacing,
} from '@ops/shared';
import { useHeaderHeight } from '@react-navigation/elements';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { TextField } from '../components/FormField';
import { Message } from '../components/Message';
import { LocalPhotoGrid } from '../components/PhotoGrid';
import { ScreenContainer } from '../components/ScreenContainer';
import { CaptureRow } from '../components/SmartCapture';
import { useRepositories } from '../data/DataProvider';
import { useSmartCapture } from '../data/queries';
import { PHOTO_STORAGE_FULL } from '../data/repositories';
import { deleteLocalFile } from '../device/files';
import { pickPhotos } from '../device/photos';
import { captureLanguageHint } from '../device/voice';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { t } from '../i18n';
import { errorText } from '../i18n/errorText';
import { captureState } from '../logic/smartCapture';
import type { StackScreenProps } from '../navigation/types';
import type { SmartCaptureInput } from '../offline/types';
import type { LocalPhoto } from '../storage/localPhoto';

/**
 * "Speak", "Snap" or "Type a note" (Phase 7, ADR-0010). The capture is saved on the phone and
 * queued at once, online or offline; once the server has processed it, "Review the proposal"
 * opens the New log form filled from it. The worker can always fill the form by hand instead.
 */
export function CaptureScreen({ route, navigation }: Readonly<StackScreenProps<'Capture'>>) {
  const { kind, taskId } = route.params;
  const repositories = useRepositories();
  const headerHeight = useHeaderHeight();
  const recorder = useVoiceRecorder();
  const [photo, setPhoto] = useState<LocalPhoto | null>(null);
  const [photoNotice, setPhotoNotice] = useState<'denied' | 'failed' | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [captureClientId, setCaptureClientId] = useState<string | null>(null);
  const capture = useSmartCapture(captureClientId ?? undefined);

  useEffect(() => {
    navigation.setOptions({ title: t(`capture.titles.${kind}`) });
  }, [kind, navigation]);

  async function takePhoto(): Promise<void> {
    if (photoBusy) return;
    setPhotoNotice(null);
    setPhotoBusy(true);
    try {
      const result = await pickPhotos('camera', 1, 0);
      if (result.status === 'denied') setPhotoNotice('denied');
      if (result.status === 'picked' && result.photos[0]) {
        if (photo) void deleteLocalFile(photo.uri);
        setPhoto(result.photos[0]);
      }
      if (result.status === 'picked' && result.failed > 0) setPhotoNotice('failed');
    } catch {
      setPhotoNotice('failed');
    } finally {
      setPhotoBusy(false);
    }
  }

  function inputToSend(): SmartCaptureInput | null {
    if (kind === 'voice') return recorder.audio ? { kind: 'voice', audio: recorder.audio } : null;
    if (kind === 'photo') {
      const trimmed = note.trim();
      return photo ? { kind: 'photo', photo, note: trimmed === '' ? null : trimmed } : null;
    }
    const trimmed = text.trim();
    return trimmed === '' ? null : { kind: 'text', text: trimmed };
  }

  async function send(): Promise<void> {
    const input = inputToSend();
    if (!input || sending) return;
    setSending(true);
    setSendError(null);
    const result = await repositories.captures.start(input, {
      taskId: taskId ?? null,
      capturedAt: new Date().toISOString(),
      languageHint: captureLanguageHint(),
    });
    setSending(false);
    if (!result.ok) {
      setSendError(
        result.error.details.some((detail) => detail.message === PHOTO_STORAGE_FULL)
          ? t('logForm.errors.photoStorageFull')
          : errorText(result.error),
      );
      return;
    }
    setCaptureClientId(result.data.captureClientId);
  }

  const openReview = () => {
    if (captureClientId) {
      navigation.replace('LogForm', { mode: 'new', taskId, captureClientId });
    }
  };

  // Sent: what happens to it now. The worker may leave; it stays in the list on Home.
  if (captureClientId) {
    const view = capture.data ?? null;
    const state = view ? captureState(view.local, view.item) : null;
    return (
      <ScreenContainer
        footer={
          <View style={styles.footer}>
            {state && state.kind !== 'waiting' ? (
              <Button
                size="large"
                icon="document-text-outline"
                label={state.kind === 'ready' ? t('capture.review') : t('capture.fillByHand')}
                onPress={openReview}
              />
            ) : (
              <Button
                size="large"
                icon="create-outline"
                label={t('capture.fillByHand')}
                onPress={openReview}
              />
            )}
            <Button
              variant="secondary"
              label={t('capture.done')}
              onPress={() => navigation.goBack()}
            />
          </View>
        }
      >
        {view ? <CaptureRow view={view} onPress={openReview} /> : null}
      </ScreenContainer>
    );
  }

  const input = inputToSend();
  const maxSeconds = Math.round(AI_CAPTURE_MAX_AUDIO_MS / 1000);

  return (
    <ScreenContainer
      keyboardOffset={headerHeight}
      footer={
        <View style={styles.footer}>
          <Button
            size="large"
            icon="sparkles-outline"
            label={sending ? t('capture.sending') : t('capture.send')}
            busy={sending}
            disabled={input === null || recorder.phase === 'recording'}
            onPress={() => void send()}
          />
          <Button
            variant="link"
            label={t('capture.fillByHand')}
            onPress={() => navigation.replace('LogForm', { mode: 'new', taskId })}
          />
        </View>
      }
    >
      <AppText variant="secondary">{t('capture.intro')}</AppText>
      {sendError ? <Message tone="error" text={sendError} /> : null}

      {kind === 'voice' ? (
        <Card>
          {recorder.phase === 'recording' ? (
            <AppText accessibilityLiveRegion="polite">
              {t('capture.recording', {
                elapsed: recorder.progress.elapsedSeconds,
                max: maxSeconds,
              })}
            </AppText>
          ) : recorder.phase === 'recorded' && recorder.audio ? (
            <AppText>
              {t('capture.recorded', {
                seconds: Math.max(1, Math.round(recorder.audio.durationMs / 1000)),
              })}
            </AppText>
          ) : null}
          {recorder.phase === 'denied' ? (
            <Message tone="notice" text={t('capture.microphoneDenied')} />
          ) : recorder.phase === 'failed' ? (
            <Message tone="error" text={t('capture.recordFailed')} />
          ) : null}
          {recorder.phase === 'recording' ? (
            <Button
              size="large"
              icon="stop-circle-outline"
              label={t('capture.stopRecording')}
              onPress={() => void recorder.stop()}
            />
          ) : (
            <Button
              size="large"
              variant={recorder.phase === 'recorded' ? 'secondary' : 'primary'}
              icon="mic-outline"
              label={recorder.phase === 'recorded' ? t('capture.recordAgain') : t('capture.record')}
              onPress={() => void recorder.start()}
            />
          )}
        </Card>
      ) : null}

      {kind === 'photo' ? (
        <View style={styles.section}>
          {photo ? (
            <LocalPhotoGrid
              photos={[photo]}
              onRemove={() => {
                void deleteLocalFile(photo.uri);
                setPhoto(null);
              }}
              onOpen={(uri) =>
                navigation.navigate('PhotoViewer', { uri, title: t('capture.titles.photo') })
              }
            />
          ) : null}
          {photoNotice === 'denied' ? (
            <Message tone="notice" text={t('capture.cameraDenied')} />
          ) : photoNotice === 'failed' ? (
            <Message tone="error" text={t('capture.photoFailed')} />
          ) : null}
          <Button
            icon="camera-outline"
            variant={photo ? 'secondary' : 'primary'}
            label={photo ? t('capture.retakePhoto') : t('capture.takePhoto')}
            busy={photoBusy}
            onPress={() => void takePhoto()}
          />
          <TextField
            label={t('capture.note')}
            placeholder={t('capture.notePlaceholder')}
            value={note}
            onValueChange={setNote}
            multiline
            autoCapitalize="sentences"
            autoCorrect
            spellCheck
            maxLength={AI_CAPTURE_MAX_PHOTO_NOTE_LENGTH}
          />
        </View>
      ) : null}

      {kind === 'text' ? (
        <TextField
          label={t('capture.text')}
          placeholder={t('capture.textPlaceholder')}
          value={text}
          onValueChange={setText}
          multiline
          autoCapitalize="sentences"
          autoCorrect
          spellCheck
          maxLength={AI_CAPTURE_MAX_TEXT_LENGTH}
        />
      ) : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  footer: {
    gap: spacing.sm,
  },
  section: {
    gap: spacing.md,
  },
});
