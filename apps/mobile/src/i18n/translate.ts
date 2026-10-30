// The translation core lives in `@ops/shared` since Phase 6 (shared with the web app, ADR-0009).
// Re-exported here so the app's imports stay `./translate`.
export {
  createTranslator,
  interpolate,
  isRtlLanguage,
  pickLanguage,
  type CatalogueShape,
  type CatalogueTree,
  type Message,
  type MessageKey,
  type PluralForms,
  type TranslateParams,
  type Translator,
} from '@ops/shared';
