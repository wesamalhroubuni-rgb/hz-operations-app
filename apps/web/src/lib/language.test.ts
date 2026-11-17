import { describe, expect, it } from 'vitest';

import { LANGUAGE_NAMES, parseLanguagePreference, resolveLanguage } from './language';

describe('dashboard language', () => {
  it('keeps only known choices; anything else follows the browser', () => {
    expect(parseLanguagePreference('tr')).toBe('tr');
    expect(parseLanguagePreference('ar')).toBe('ar');
    expect(parseLanguagePreference('fr')).toBe('system');
    expect(parseLanguagePreference(null)).toBe('system');
  });

  it('follows the first supported browser language under "system", else English', () => {
    expect(resolveLanguage('system', ['tr-TR', 'en-US'])).toBe('tr');
    expect(resolveLanguage('system', ['fr-FR', 'ar-SA'])).toBe('ar');
    expect(resolveLanguage('system', ['de-DE'])).toBe('en');
    expect(resolveLanguage('ar', ['tr-TR'])).toBe('ar');
  });

  it('names every language in its own language', () => {
    expect(LANGUAGE_NAMES).toEqual({ en: 'English', tr: 'Türkçe', ar: 'العربية' });
  });
});
