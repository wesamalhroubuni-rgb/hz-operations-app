import type { AiProviderInfo, TranscriptionRequest } from './ai-types';
import { estimateTranscriptionCostUsd } from './ai-prices';
import { fakeTokens } from './fake-llm-provider';
import { AiProviderError } from './llm-provider';
import type { SpeechToTextProvider, SpeechToTextResponse } from './speech-to-text-provider';

export const FAKE_STT_MARKER = 'FAKE-STT:';
export const FAKE_TRANSCRIPT = 'Fake transcript';
export const FAKE_STT_MODEL = 'fake-stt-1';

const MARKER_BYTES = Buffer.from(FAKE_STT_MARKER, 'ascii');

/**
 * Deterministic speech-to-text without network (ADR-0010 section 2): the transcript is the
 * UTF-8 text after `FAKE-STT:` in the audio bytes (up to a NUL byte or the end), otherwise
 * "Fake transcript". Language: the hint, else `en`. Duration: the declared one, else 1 second.
 */
export class FakeSpeechToTextProvider implements SpeechToTextProvider {
  readonly info: AiProviderInfo = { name: 'fake', model: FAKE_STT_MODEL, fake: true };

  transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<SpeechToTextResponse> {
    if (signal.aborted) {
      return Promise.reject(new AiProviderError('timeout', 'The request was aborted'));
    }
    const bytes = Buffer.from(
      request.audio.buffer,
      request.audio.byteOffset,
      request.audio.byteLength,
    );
    const start = bytes.indexOf(MARKER_BYTES);
    let text = FAKE_TRANSCRIPT;
    if (start >= 0) {
      const from = start + MARKER_BYTES.length;
      const nul = bytes.indexOf(0, from);
      text = bytes.subarray(from, nul < 0 ? bytes.length : nul).toString('utf8');
    }
    return Promise.resolve({
      text,
      language: request.languageHint ?? 'en',
      durationSeconds: request.durationSeconds ?? 1,
      usage: { inputTokens: 0, outputTokens: fakeTokens(text) },
      model: FAKE_STT_MODEL,
    });
  }

  estimateCostUsd(
    usage: { inputTokens: number; outputTokens: number; audioSeconds: number },
    model: string,
  ) {
    return estimateTranscriptionCostUsd(model, usage);
  }
}
