import { localeOf, type Locale } from '@ops/shared';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { getLocales } from 'expo-localization';

import type { LocalAudio } from '../offline/types';

// Voice notes for smart capture (Phase 7, ADR-0010), recorded with expo-audio as AAC in an MP4
// container (`.m4a`, `audio/mp4`) on Android and iOS. The file stays in the user's offline
// audio folder until the server has processed it.

/** Asks for the microphone once; false when the worker refused (the screen explains). */
export async function ensureMicrophone(): Promise<boolean> {
  const current = await getRecordingPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await requestRecordingPermissionsAsync()).granted;
}

function fileSize(uri: string): number {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

/** The recorded file as a voice note of the queue. */
export function localAudioFromRecording(uri: string, durationMs: number): LocalAudio {
  return {
    localId: randomUUID(),
    uri,
    fileName: 'voice-note.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: fileSize(uri),
    durationMs: Math.max(1, Math.round(durationMs)),
  };
}

/** The phone's language as a hint for speech-to-text (which also detects it). */
export function captureLanguageHint(): Locale {
  return localeOf(getLocales()[0]?.languageCode ?? undefined);
}
