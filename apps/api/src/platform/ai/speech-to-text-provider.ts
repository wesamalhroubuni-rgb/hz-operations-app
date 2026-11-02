/**
 * The speech-to-text provider interface (reusable platform component, Phase 7, ADR-0010).
 *
 * CONTRACT FILE: no implementation. Implementations: `OpenAiSpeechToTextProvider` (plain
 * `fetch` to `POST https://api.openai.com/v1/audio/transcriptions`, multipart, model from
 * `AI_STT_MODEL`, default `gpt-4o-transcribe`, key `OPENAI_API_KEY`) and
 * `FakeSpeechToTextProvider` (deterministic, no network). Bound under `SPEECH_TO_TEXT_PROVIDER`
 * by the provider registry.
 *
 * Only the audio bytes, a neutral file name and the language hint are sent: no user id, name or
 * other context. Like the LLM provider it makes one request, no retry, no tracing.
 */
import type { AiProviderInfo, Transcription, TranscriptionRequest } from './ai-types';

export interface SpeechToTextResponse extends Transcription {
  /** Token usage when the provider reports it (gpt-4o-transcribe does), else zeros. */
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface SpeechToTextProvider {
  readonly info: AiProviderInfo;
  /** Rejects with an `AiProviderError` (`./llm-provider`) on failure or when `signal` aborts. */
  transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<SpeechToTextResponse>;
  /** Estimated cost in US dollars (by tokens, or by audio seconds for per-minute pricing). */
  estimateCostUsd(
    usage: { inputTokens: number; outputTokens: number; audioSeconds: number },
    model: string,
  ): number | null;
}

export const SPEECH_TO_TEXT_PROVIDER = Symbol('platform.speechToTextProvider');
