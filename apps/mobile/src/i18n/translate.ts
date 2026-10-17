// The translation core: typed keys, `{{name}}` interpolation and plural forms. No React and no
// Expo here, so it is unit-tested directly. `src/i18n/index.ts` picks the catalogue for the
// phone's language.

/**
 * Plural forms of one message, by CLDR category (`Intl.PluralRules`). `other` is required;
 * English uses `one` and `other`, Arabic may use all six.
 */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export type Message = string | PluralForms;

export interface CatalogueTree {
  [key: string]: Message | CatalogueTree;
}

/** Every dotted key of a catalogue whose value is a message, e.g. `tasks.filters.open`. */
export type MessageKey<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends { other: string }
      ? `${Prefix}${K}`
      : MessageKey<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/**
 * The shape another language must have: the same keys as English, each a string (or plural
 * forms where English has them). TypeScript then reports a missing or misspelt key in `tr.ts`.
 */
export type CatalogueShape<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends { other: string }
      ? PluralForms
      : CatalogueShape<T[K]>;
};

export type TranslateParams = Record<string, string | number>;

function isPlural(value: unknown): value is PluralForms {
  return (
    typeof value === 'object' && value !== null && typeof (value as PluralForms).other === 'string'
  );
}

function lookup(catalogue: CatalogueTree, key: string): Message | undefined {
  let node: Message | CatalogueTree | undefined = catalogue;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || isPlural(node)) return undefined;
    node = (node as CatalogueTree)[part];
  }
  return typeof node === 'string' || isPlural(node) ? node : undefined;
}

function pluralCategory(locale: string, count: number): keyof PluralForms {
  try {
    return new Intl.PluralRules(locale).select(count) as keyof PluralForms;
  } catch {
    return count === 1 ? 'one' : 'other';
  }
}

export function interpolate(text: string, params: TranslateParams = {}): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export interface Translator<Key extends string> {
  locale: string;
  t(key: Key, params?: TranslateParams): string;
}

/**
 * A translator over `catalogue`, falling back to `fallback` (English) for a key the catalogue
 * lacks at run time, and to the key itself as a last resort (visible, never a crash). A plural
 * message picks its form from `params.count`.
 */
export function createTranslator<Key extends string>(
  locale: string,
  catalogue: CatalogueTree,
  fallback: CatalogueTree,
): Translator<Key> {
  return {
    locale,
    t(key, params) {
      const message = lookup(catalogue, key) ?? lookup(fallback, key);
      if (message === undefined) return key;
      if (typeof message === 'string') return interpolate(message, params);
      const count = typeof params?.count === 'number' ? params.count : 0;
      const form = message[pluralCategory(locale, count)] ?? message.other;
      return interpolate(form, params);
    },
  };
}

/** Languages written right to left. Used to decide the layout direction. */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

export function isRtlLanguage(languageCode: string): boolean {
  return RTL_LANGUAGES.has(languageCode.toLowerCase());
}

/**
 * The first of the phone's preferred languages that has a catalogue, or the default. `preferred`
 * are language codes in the phone's order (`['tr', 'en']`).
 */
export function pickLanguage<Code extends string>(
  preferred: readonly (string | null | undefined)[],
  available: readonly Code[],
  fallback: Code,
): Code {
  for (const code of preferred) {
    const normalised = code?.toLowerCase().split(/[-_]/)[0];
    const match = available.find((candidate) => candidate === normalised);
    if (match) return match;
  }
  return fallback;
}
