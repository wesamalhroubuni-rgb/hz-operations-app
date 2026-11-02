import { type DynamicModule, Logger, Module, type ModuleMetadata, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiRunnerService } from './ai-runner.service';
import { AI_SETTINGS, aiSettingsFromConfig, type AiSettings } from './ai-settings';
import { AiTraceService } from './ai-trace.service';
import {
  AI_ORGANIZATION_LIMITS,
  AI_PROMPT_DIRECTORIES,
  AI_RUNNER,
  AI_USAGE_READER,
  PROMPT_LOADER,
  type AiOrganizationLimitsResolver,
} from './ai-types';
import { AiUsageReportService } from './ai-usage-report.service';
import { LLM_PROVIDER } from './llm-provider';
import { FilePromptLoader } from './prompt-loader';
import { resolveAiProviders, type AiProviders } from './provider-registry';
import { SPEECH_TO_TEXT_PROVIDER } from './speech-to-text-provider';
import { AiUsageLimiter } from './usage-limiter';

/** Internal token: the providers chosen at boot. */
export const AI_PROVIDERS = Symbol('platform.aiProviders');

export interface AiModuleOptions {
  /** Absolute paths of the folders holding `<id>.v<N>.md` prompt files. */
  promptDirectories: readonly string[];
  /** The host's resolver of an organization's own limits (bound to `AI_ORGANIZATION_LIMITS`). */
  organizationLimits: Type<AiOrganizationLimitsResolver>;
  /** Modules the resolver needs (global ones, such as the database, need not be listed). */
  imports?: ModuleMetadata['imports'];
}

/**
 * The AI layer (reusable platform component, ADR-0010): the provider registry, the runner,
 * traces, usage limits, the prompt loader and the usage report. Global once registered, so a
 * feature module injects `AI_RUNNER` (and `PROMPT_LOADER`) without importing anything.
 *
 * Host requirements: a global `PrismaService` with the `aiTrace` table; a global
 * `ConfigService` answering the `AI_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `NODE_ENV`
 * keys (./ai-settings.ts); `AUTH_CLOCK` from the platform module; and, through
 * {@link AiModule.register}, its prompt folders and its organization limits.
 *
 * Replaceable parts, by overriding the token: `LLM_PROVIDER` and `SPEECH_TO_TEXT_PROVIDER`
 * (tests bind scripted providers; a null value means "unavailable").
 */
@Module({})
export class AiModule {
  static register(options: AiModuleOptions): DynamicModule {
    return {
      module: AiModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        { provide: AI_SETTINGS, inject: [ConfigService], useFactory: aiSettingsFromConfig },
        {
          provide: AI_PROVIDERS,
          inject: [AI_SETTINGS],
          useFactory: (settings: AiSettings): AiProviders => {
            const providers = resolveAiProviders(settings);
            new Logger('AiModule').log(
              `AI providers: llm=${describe(providers.llm?.info)} ` +
                `speechToText=${describe(providers.speechToText?.info)}`,
            );
            return providers;
          },
        },
        {
          provide: LLM_PROVIDER,
          inject: [AI_PROVIDERS],
          useFactory: (providers: AiProviders) => providers.llm,
        },
        {
          provide: SPEECH_TO_TEXT_PROVIDER,
          inject: [AI_PROVIDERS],
          useFactory: (providers: AiProviders) => providers.speechToText,
        },
        { provide: AI_PROMPT_DIRECTORIES, useValue: [...options.promptDirectories] },
        {
          provide: PROMPT_LOADER,
          inject: [AI_PROMPT_DIRECTORIES],
          useFactory: (directories: string[]) => new FilePromptLoader(directories),
        },
        options.organizationLimits,
        { provide: AI_ORGANIZATION_LIMITS, useExisting: options.organizationLimits },
        AiTraceService,
        { provide: AI_USAGE_READER, useExisting: AiTraceService },
        {
          provide: AiUsageLimiter,
          inject: [AI_SETTINGS, AI_ORGANIZATION_LIMITS, AiTraceService],
          useFactory: (
            settings: AiSettings,
            organizations: AiOrganizationLimitsResolver,
            traces: AiTraceService,
          ) => new AiUsageLimiter(settings, organizations, traces),
        },
        AiRunnerService,
        { provide: AI_RUNNER, useExisting: AiRunnerService },
        AiUsageReportService,
      ],
      exports: [
        AI_SETTINGS,
        AI_RUNNER,
        AI_USAGE_READER,
        PROMPT_LOADER,
        AI_ORGANIZATION_LIMITS,
        AiTraceService,
        AiUsageLimiter,
        AiUsageReportService,
      ],
    };
  }
}

function describe(info: { name: string; model: string } | undefined): string {
  return info ? `${info.name}/${info.model}` : 'unavailable';
}
