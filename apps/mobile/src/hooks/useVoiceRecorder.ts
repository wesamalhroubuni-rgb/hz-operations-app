import { AI_CAPTURE_MAX_AUDIO_MS } from '@ops/shared';
import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureMicrophone, localAudioFromRecording } from '../device/voice';
import { recordingProgress } from '../logic/smartCapture';
import type { LocalAudio } from '../offline/types';

export type RecorderPhase = 'idle' | 'recording' | 'recorded' | 'denied' | 'failed';

/**
 * Records one voice note of at most two minutes (`AI_CAPTURE_MAX_AUDIO_MS`), stopping by itself
 * at the limit. The recording is a local file until the worker sends it.
 */
export function useVoiceRecorder() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [audio, setAudio] = useState<LocalAudio | null>(null);
  const stopping = useRef(false);

  const start = useCallback(async () => {
    setAudio(null);
    try {
      if (!(await ensureMicrophone())) {
        setPhase('denied');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      stopping.current = false;
      setPhase('recording');
    } catch {
      setPhase('failed');
    }
  }, [recorder]);

  const stop = useCallback(async () => {
    if (stopping.current) return;
    stopping.current = true;
    try {
      const durationMs = recorder.getStatus().durationMillis;
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      const uri = recorder.uri;
      if (!uri) {
        setPhase('failed');
        return;
      }
      setAudio(localAudioFromRecording(uri, Math.min(durationMs, AI_CAPTURE_MAX_AUDIO_MS)));
      setPhase('recorded');
    } catch {
      setPhase('failed');
    }
  }, [recorder]);

  const progress = recordingProgress(state.durationMillis, AI_CAPTURE_MAX_AUDIO_MS);
  useEffect(() => {
    if (phase !== 'recording' || !progress.reachedMax) return;
    // At the limit the recording stops by itself (on the next tick, outside the render).
    const timer = setTimeout(() => void stop(), 0);
    return () => clearTimeout(timer);
  }, [phase, progress.reachedMax, stop]);

  const reset = useCallback(() => {
    setAudio(null);
    setPhase('idle');
  }, []);

  return { phase, audio, progress, start, stop, reset };
}
