import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AI_SETTINGS, type AiSettings } from './ai-settings';
import {
  AI_ORGANIZATION_KEYS,
  type AiOrganizationKeys,
  type AiOrganizationKeysResolver,
  type AiProviderSource,
} from './ai-types';
import { LLM_PROVIDER, type LlmProvider } from './llm-provider';
import { AI_REAL_PROVIDER_FACTORIES, type RealProviderFactories } from './provider-registry';
import { SPEECH_TO_TEXT_PROVIDER, type SpeechToTextProvider } from './speech-to-text-provider';

/** The providers one organization's calls use, and where each comes from. */
export interface OrganizationProviders {
  llm: LlmProvider | null;
  speechToText: SpeechToTextProvider | null;
  sources: { llm: AiProviderSource; speechToText: AiProviderSource };
  /** The models chosen for the organization (its own choice, else the server's). */
  models: { llm: string; speechToText: string };
}

const NO_KEYS: AiOrganizationKeys = { anthropicApiKey: null, openAiApiKey: null };

/** A short fingerprint of a key, so a changed key builds a new provider (never logged). */
function fingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/**
 * Chooses the providers of each call (ADR-0012): the organization's own key and model when it
 * chose them,
 * else the providers chosen at boot from the environment (ADR-0010: the server's key, the test
 * fakes outside production, or none). Under `AI_PROVIDER=fake` the fakes always answer and
 * organization keys are ignored, so tests and demos never reach the network.
 *
 * Providers built from an organization's key are cached per organization and key fingerprint;
 * the keys are read for every call (one indexed query), so a saved, replaced or removed key
 * applies to the next call in every API process.
 */
@Injectable()
export class AiProviderSelector {
  private readonly logger = new Logger('AiProviderSelector');
  private readonly llmCache = new Map<string, { fingerprint: string; provider: LlmProvider }>();
  private readonly speechCache = new Map<
    string,
    { fingerprint: string; provider: SpeechToTextProvider }
  >();

  constructor(
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
    @Inject(LLM_PROVIDER) private readonly bootLlm: LlmProvider | null,
    @Inject(SPEECH_TO_TEXT_PROVIDER) private readonly bootSpeech: SpeechToTextProvider | null,
    @Inject(AI_REAL_PROVIDER_FACTORIES) private readonly factories: RealProviderFactories,
    @Optional()
    @Inject(AI_ORGANIZATION_KEYS)
    private readonly keys: AiOrganizationKeysResolver | null,
  ) {}

  async forOrganization(organizationId: string): Promise<OrganizationProviders> {
    const keys = await this.keysOf(organizationId);
    const models = {
      llm: keys.llmModel ?? this.settings.llmModel,
      speechToText: keys.speechToTextModel ?? this.settings.sttModel,
    };

    let llm = this.bootLlm;
    let llmSource = this.bootSource(this.bootLlm);
    if (keys.anthropicApiKey) {
      llm = this.cachedLlm(organizationId, keys.anthropicApiKey, models.llm);
      llmSource = 'organization';
    } else if (
      this.usesServerKeyWithOtherModel(this.bootLlm, this.settings.anthropicApiKey, keys.llmModel)
    ) {
      llm = this.cachedLlm(organizationId, this.settings.anthropicApiKey!, models.llm);
    } else {
      // A removed or unreadable key: drop its provider, so the plain key leaves memory.
      this.llmCache.delete(organizationId);
    }

    let speechToText = this.bootSpeech;
    let speechSource = this.bootSource(this.bootSpeech);
    if (keys.openAiApiKey) {
      speechToText = this.cachedSpeech(organizationId, keys.openAiApiKey, models.speechToText);
      speechSource = 'organization';
    } else if (
      this.usesServerKeyWithOtherModel(
        this.bootSpeech,
        this.settings.openAiApiKey,
        keys.speechToTextModel,
      )
    ) {
      speechToText = this.cachedSpeech(
        organizationId,
        this.settings.openAiApiKey!,
        models.speechToText,
      );
    } else {
      this.speechCache.delete(organizationId);
    }

    return { llm, speechToText, sources: { llm: llmSource, speechToText: speechSource }, models };
  }

  /**
   * The server's real provider serves this organization, but the organization chose another
   * model: build one with the server's key and that model.
   */
  private usesServerKeyWithOtherModel(
    boot: { info: { fake: boolean; model: string } } | null,
    serverKey: string | null,
    chosenModel: string | null | undefined,
  ): boolean {
    return (
      typeof chosenModel === 'string' &&
      boot !== null &&
      !boot.info.fake &&
      serverKey !== null &&
      boot.info.model !== chosenModel
    );
  }
  private async keysOf(organizationId: string): Promise<AiOrganizationKeys> {
    if (this.settings.mode === 'fake' || !this.keys) {
      return NO_KEYS;
    }
    try {
      return await this.keys.keysFor(organizationId);
    } catch {
      // The resolver should not throw; if it does, the server's providers still serve.
      this.logger.error(`ai keys unreadable organizationId=${organizationId}`);
      return NO_KEYS;
    }
  }

  private bootSource(provider: { info: { fake: boolean } } | null): AiProviderSource {
    if (!provider) return 'none';
    return provider.info.fake ? 'test' : 'environment';
  }

  private cachedLlm(organizationId: string, apiKey: string, model: string): LlmProvider {
    const print = fingerprint(`${model}|${apiKey}`);
    const cached = this.llmCache.get(organizationId);
    if (cached?.fingerprint === print) return cached.provider;
    const provider = this.factories.llm(apiKey, model, {
      refusalFallback: this.settings.anthropicRefusalFallback,
    });
    this.llmCache.set(organizationId, { fingerprint: print, provider });
    return provider;
  }

  private cachedSpeech(
    organizationId: string,
    apiKey: string,
    model: string,
  ): SpeechToTextProvider {
    const print = fingerprint(`${model}|${apiKey}`);
    const cached = this.speechCache.get(organizationId);
    if (cached?.fingerprint === print) return cached.provider;
    const provider = this.factories.speechToText(apiKey, model);
    this.speechCache.set(organizationId, { fingerprint: print, provider });
    return provider;
  }
}
