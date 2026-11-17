import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_SETTINGS, type AiSettings } from './ai-settings';
import { AiProviderError } from './llm-provider';
import { AI_REAL_PROVIDER_FACTORIES, type RealProviderFactories } from './provider-registry';

/** The kind of provider a key is for. */
export type AiKeyKind = 'llm' | 'speechToText';

export type AiKeyCheck =
  | { ok: true }
  /** `rejected`: the provider refused the key; `unavailable`: it could not be asked. */
  | { ok: false; failure: 'rejected' | 'unavailable'; errorCode: string };

/** Provider answers that mean "this key will not work" rather than an outage. */
const REJECTING_CODES = new Set(['http_400', 'http_401', 'http_403', 'http_404', 'http_422']);

/**
 * Checks an API key with its provider before an organization stores it (ADR-0012), with a
 * request that generates nothing and costs nothing (the configured model's metadata). Bounded by
 * `AI_REQUEST_TIMEOUT_MS`. Not traced (no model call) and not counted against the limits; the log
 * line holds the organization id, the kind and the outcome code, never the key.
 */
@Injectable()
export class AiKeyChecker {
  private readonly logger = new Logger('AiKeyChecker');

  constructor(
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
    @Inject(AI_REAL_PROVIDER_FACTORIES) private readonly factories: RealProviderFactories,
  ) {}

  /** `model`: the model the key must reach (the organization's choice); default the server's. */
  async check(
    organizationId: string,
    kind: AiKeyKind,
    apiKey: string,
    model?: string,
  ): Promise<AiKeyCheck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);
    timer.unref?.();
    try {
      if (kind === 'llm') {
        await this.factories.checkLlmKey(
          apiKey,
          model ?? this.settings.llmModel,
          controller.signal,
        );
      } else {
        await this.factories.checkSpeechToTextKey(
          apiKey,
          model ?? this.settings.sttModel,
          controller.signal,
        );
      }
      this.logger.log(`ai key check organizationId=${organizationId} kind=${kind} status=ok`);
      return { ok: true };
    } catch (error) {
      const errorCode = controller.signal.aborted
        ? 'timeout'
        : error instanceof AiProviderError
          ? error.code
          : 'provider_error';
      const failure = REJECTING_CODES.has(errorCode) ? 'rejected' : 'unavailable';
      this.logger.warn(
        `ai key check organizationId=${organizationId} kind=${kind} status=${failure} ` +
          `errorCode=${errorCode}`,
      );
      return { ok: false, failure, errorCode };
    } finally {
      clearTimeout(timer);
    }
  }
}
