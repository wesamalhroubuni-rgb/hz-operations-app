import type { AiSettings } from './ai-settings';
import { AnthropicLlmProvider, type AnthropicLlmOptions } from './anthropic-llm-provider';
import { FakeLlmProvider } from './fake-llm-provider';
import { FakeSpeechToTextProvider } from './fake-speech-to-text-provider';
import type { LlmProvider } from './llm-provider';
import { OpenAiSpeechToTextProvider } from './openai-speech-to-text-provider';
import type { SpeechToTextProvider } from './speech-to-text-provider';

export interface AiProviders {
  /** Null: unavailable (production without `ANTHROPIC_API_KEY` under `auto`). */
  llm: LlmProvider | null;
  speechToText: SpeechToTextProvider | null;
}

/** How to build the real providers (tests replace them to stay off the network). */
export interface RealProviderFactories {
  llm(apiKey: string, model: string, options: AnthropicLlmOptions): LlmProvider;
  speechToText(apiKey: string, model: string): SpeechToTextProvider;
}

const REAL_PROVIDERS: RealProviderFactories = {
  llm: (apiKey, model, options) => new AnthropicLlmProvider(apiKey, model, undefined, options),
  speechToText: (apiKey, model) => new OpenAiSpeechToTextProvider(apiKey, model),
};

/**
 * Chooses the providers from `AI_PROVIDER` and the keys (ADR-0010 section 2):
 * - `auto`: real for each kind whose key is set; otherwise the fake, except in production,
 *   where that kind is unavailable (null);
 * - `fake`: both fakes; refused in production;
 * - `real`: both real; both keys required.
 * Throws for a configuration the environment schema should already have refused.
 */
export function resolveAiProviders(
  settings: AiSettings,
  real: RealProviderFactories = REAL_PROVIDERS,
): AiProviders {
  const production = settings.nodeEnv === 'production';
  if (settings.mode === 'fake') {
    if (production) {
      throw new Error('AI_PROVIDER=fake is refused in production');
    }
    return { llm: new FakeLlmProvider(), speechToText: new FakeSpeechToTextProvider() };
  }
  if (settings.mode === 'real') {
    const missing = [
      settings.anthropicApiKey ? null : 'ANTHROPIC_API_KEY',
      settings.openAiApiKey ? null : 'OPENAI_API_KEY',
    ].filter((name) => name !== null);
    if (missing.length > 0) {
      throw new Error(`AI_PROVIDER=real needs ${missing.join(' and ')}`);
    }
  }
  const llm = settings.anthropicApiKey
    ? real.llm(settings.anthropicApiKey, settings.llmModel, {
        refusalFallback: settings.anthropicRefusalFallback,
      })
    : production
      ? null
      : new FakeLlmProvider();
  const speechToText = settings.openAiApiKey
    ? real.speechToText(settings.openAiApiKey, settings.sttModel)
    : production
      ? null
      : new FakeSpeechToTextProvider();
  return { llm, speechToText };
}
