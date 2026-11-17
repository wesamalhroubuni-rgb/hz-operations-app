// The AI platform layer (ADR-0010). Features code against `AiRunner` (token `AI_RUNNER`) and
// `untrustedDataBlock`; they never call a provider directly.
export * from './ai-types';
export * from './llm-provider';
export * from './speech-to-text-provider';
export { untrustedDataBlock } from './prompt-data';
export { AiModule, type AiModuleOptions } from './ai.module';
export { AI_SETTINGS, type AiSettings } from './ai-settings';
export { AiTraceService } from './ai-trace.service';
export { AiUsageLimiter } from './usage-limiter';
export { AiUsageReportService } from './ai-usage-report.service';
// ADR-0012: an organization's own provider keys.
export { AiKeyChecker, type AiKeyCheck, type AiKeyKind } from './ai-key-checker';
export { AiProviderSelector, type OrganizationProviders } from './provider-selector';
export {
  AI_REAL_PROVIDER_FACTORIES,
  REAL_PROVIDERS,
  type RealProviderFactories,
} from './provider-registry';
export { FakeLlmProvider, FAKE_LLM_MARKERS, FAKE_NARRATIVE } from './fake-llm-provider';
export {
  FakeSpeechToTextProvider,
  FAKE_STT_MARKER,
  FAKE_TRANSCRIPT,
} from './fake-speech-to-text-provider';
