import { en } from './en';
import {
  createTranslator,
  interpolate,
  isRtlLanguage,
  pickLanguage,
  type CatalogueTree,
} from './translate';

const catalogue = en as unknown as CatalogueTree;

describe('translator', () => {
  const t = createTranslator<string>('en', catalogue, catalogue);

  it('looks up dotted keys and fills in parameters', () => {
    expect(t.t('tasks.filters.open')).toBe('Open');
    expect(t.t('home.greeting', { name: 'Deniz' })).toBe('Hello, Deniz');
  });

  it('picks the plural form from count', () => {
    expect(t.t('tabs.unreadBadge', { count: 1 })).toBe('1 unread notification');
    expect(t.t('tabs.unreadBadge', { count: 3 })).toBe('3 unread notifications');
  });

  it('falls back to English for a key another language lacks, then to the key itself', () => {
    const turkish = createTranslator<string>('tr', { common: { retry: 'Tekrar dene' } }, catalogue);
    expect(turkish.t('common.retry')).toBe('Tekrar dene');
    expect(turkish.t('common.cancel')).toBe('Cancel');
    expect(turkish.t('no.such.key')).toBe('no.such.key');
  });

  it('uses the language plural rules (Arabic has more forms)', () => {
    const arabic = createTranslator<string>(
      'ar',
      { n: { zero: 'zero', one: 'one', two: 'two', few: 'few', many: 'many', other: 'other' } },
      catalogue,
    );
    expect(arabic.t('n', { count: 2 })).toBe('two');
    expect(arabic.t('n', { count: 5 })).toBe('few');
  });

  it('leaves an unknown placeholder visible rather than empty', () => {
    expect(interpolate('Due {{date}}', {})).toBe('Due {{date}}');
  });
});

describe('the English catalogue', () => {
  function leaves(node: unknown, path: string[] = []): [string, unknown][] {
    if (typeof node === 'string') return [[path.join('.'), node]];
    const record = node as Record<string, unknown>;
    if (typeof record.other === 'string') return [[path.join('.'), record.other]];
    return Object.entries(record).flatMap(([key, value]) => leaves(value, [...path, key]));
  }

  it('has no empty message', () => {
    for (const [key, value] of leaves(en)) {
      expect({ key, empty: typeof value !== 'string' || value.trim() === '' }).toEqual({
        key,
        empty: false,
      });
    }
  });

  it('wraps the shared sign-in wording', () => {
    expect(en.auth.signIn).toBe('Sign in');
    expect(en.authFailures.network).toMatch(/server/);
  });
});

describe('language choice', () => {
  it('takes the first preferred language that has a catalogue', () => {
    expect(pickLanguage(['de-DE', 'tr-TR', 'en'], ['en', 'tr'], 'en')).toBe('tr');
    expect(pickLanguage(['fr'], ['en'], 'en')).toBe('en');
    expect(pickLanguage([null, undefined], ['en'], 'en')).toBe('en');
  });

  it('knows which languages are written right to left', () => {
    expect(isRtlLanguage('ar')).toBe(true);
    expect(isRtlLanguage('tr')).toBe(false);
  });
});
