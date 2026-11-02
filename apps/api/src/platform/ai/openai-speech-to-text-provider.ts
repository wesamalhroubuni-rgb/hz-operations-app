import type { AiProviderInfo, TranscriptionRequest } from './ai-types';
import { estimateTranscriptionCostUsd } from './ai-prices';
import { AiProviderError } from './llm-provider';
import type { SpeechToTextProvider, SpeechToTextResponse } from './speech-to-text-provider';

export const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

interface TranscriptionBody {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  usage?: {
    type?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    seconds?: unknown;
  };
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** HTTP statuses that mean "this audio cannot be transcribed", not "the service failed". */
const INPUT_REJECTED_STATUSES = new Set([400, 413, 415]);

/**
 * OpenAI speech-to-text (`gpt-4o-transcribe` by default) through one multipart `fetch`
 * (ADR-0010 section 2). Sends only the audio bytes, a neutral file name, the model and the
 * language hint. One request, no retry; the runner's timeout arrives as the abort signal.
 */
export class OpenAiSpeechToTextProvider implements SpeechToTextProvider {
  readonly info: AiProviderInfo;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly url: string = OPENAI_TRANSCRIPTIONS_URL,
  ) {
    this.info = { name: 'openai', model, fake: false };
  }

  async transcribe(
    request: TranscriptionRequest,
    signal: AbortSignal,
  ): Promise<SpeechToTextResponse> {
    const form = new FormData();
    const bytes = new Uint8Array(request.audio.byteLength);
    bytes.set(request.audio);
    form.append('file', new Blob([bytes], { type: request.mimeType }), request.fileName);
    form.append('model', this.model);
    form.append('response_format', 'json');
    if (request.languageHint) {
      form.append('language', request.languageHint);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal,
      });
    } catch {
      throw signal.aborted
        ? new AiProviderError('timeout', 'The speech-to-text request timed out')
        : new AiProviderError('network', 'The speech-to-text service could not be reached');
    }
    if (!response.ok) {
      // The body is not read into any message: it may echo request details.
      await response.body?.cancel().catch(() => undefined);
      if (INPUT_REJECTED_STATUSES.has(response.status)) {
        throw new AiProviderError(
          'input_rejected',
          `The speech-to-text service refused the audio (HTTP ${response.status})`,
        );
      }
      throw new AiProviderError(
        `http_${response.status}`,
        `The speech-to-text service answered HTTP ${response.status}`,
      );
    }

    let body: TranscriptionBody;
    try {
      body = (await response.json()) as TranscriptionBody;
    } catch {
      throw signal.aborted
        ? new AiProviderError('timeout', 'The speech-to-text request timed out')
        : new AiProviderError('bad_response', 'The speech-to-text answer was not JSON');
    }
    if (typeof body.text !== 'string') {
      throw new AiProviderError('bad_response', 'The speech-to-text answer had no text');
    }
    const usage = body.usage ?? {};
    const tokens = usage.type === 'tokens';
    const duration =
      usage.type === 'duration' ? count(usage.seconds) : count(body.duration) || null;
    return {
      text: body.text,
      language: typeof body.language === 'string' ? body.language : null,
      durationSeconds: duration,
      usage: {
        inputTokens: tokens ? count(usage.input_tokens) : 0,
        outputTokens: tokens ? count(usage.output_tokens) : 0,
      },
      model: this.model,
    };
  }

  estimateCostUsd(
    usage: { inputTokens: number; outputTokens: number; audioSeconds: number },
    model: string,
  ) {
    return estimateTranscriptionCostUsd(model, usage);
  }
}
