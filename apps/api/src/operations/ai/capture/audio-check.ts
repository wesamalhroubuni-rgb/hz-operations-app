import type { AiCaptureAudioMimeType } from '@ops/shared';

// Verification of an uploaded voice note by its CONTENT (ADR-0010 section 6): the declared type
// is trusted only when the first bytes are those of that container. The audio is not decoded
// (the speech-to-text provider does that); a file that only looks like audio fails there and
// becomes `input_unusable`.

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
  if (bytes.length < start + text.length) {
    return false;
  }
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[start + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/** The audio container the first bytes announce, or null when none of the accepted ones. */
export function sniffAudioType(bytes: Uint8Array): AiCaptureAudioMimeType | null {
  // MP4 / M4A: a box size (4 bytes) then `ftyp`.
  if (ascii(bytes, 4, 'ftyp')) {
    return 'audio/mp4';
  }
  if (ascii(bytes, 0, 'OggS')) {
    return 'audio/ogg';
  }
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) {
    return 'audio/wav';
  }
  // WebM / Matroska: the EBML header.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm';
  }
  // MP3: an ID3 tag, or an MPEG audio frame sync (11 set bits).
  if (ascii(bytes, 0, 'ID3')) {
    return 'audio/mpeg';
  }
  const first = bytes[0];
  const second = bytes[1];
  if (first !== undefined && second !== undefined && first === 0xff && (second & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  return null;
}

export type AudioCheck = { ok: true } | { ok: false; reason: 'not_audio' | 'type_mismatch' };

/** Whether `bytes` are an audio file of the `declared` type (by magic bytes). */
export function checkAudio(bytes: Uint8Array, declared: AiCaptureAudioMimeType): AudioCheck {
  const sniffed = sniffAudioType(bytes);
  if (sniffed === null) {
    return { ok: false, reason: 'not_audio' };
  }
  return sniffed === declared ? { ok: true } : { ok: false, reason: 'type_mismatch' };
}

const EXTENSIONS: Record<AiCaptureAudioMimeType, string> = {
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
};

/** The neutral file name sent to speech-to-text (never the user's own file name). */
export function neutralAudioFileName(mimeType: AiCaptureAudioMimeType): string {
  return `capture.${EXTENSIONS[mimeType]}`;
}
