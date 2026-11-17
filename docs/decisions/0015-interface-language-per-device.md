# ADR-0015: Interface language chosen per browser and per phone

- **Status**: Accepted
- **Date**: 2026-11-17
- **Phase**: between 7 and 8 (owner request: Turkish and Arabic in both apps)
- **Amends**: [ADR-0009](0009-web-dashboard-architecture.md) section "Internationalisation and RTL"
  (the dashboard's language was to come from `User.locale` once a second catalogue existed)

## Context

Until 2026-11-17 both apps had English catalogues only. ADR-0009 fixed the dashboard to English
(`LOCALE`) and planned to pick its language from the signed-in user's `User.locale` once a second
catalogue existed; the phone picked its language from the device (`expo-localization`). Turkish
and Arabic catalogues now exist in both apps, so the apps need a rule for which one is shown, and
the sign-in pages need a language before anyone is signed in.

## Decision

1. **Catalogues.** Web: `apps/web/src/i18n/tr/` and `ar/`, one file per namespace like `en/`,
   assembled in `tr.ts` and `ar.ts`. Mobile: `apps/mobile/src/i18n/tr.ts` and `ar.ts`. Every
   catalogue is typed `CatalogueShape<EnglishCatalogue>`, so a missing or misspelt key fails the
   typecheck; English remains the fallback key by key. The sign-in, activation and sign-out
   sentences in Turkish and Arabic are shared by both apps (`AUTH_TRANSLATIONS` in
   `packages/shared/src/api-client/auth-translations.ts`).
2. **The choice is a device preference**, like the theme: `System` (the default: the browser's or
   phone's preferred languages, English when none matches), `English`, `Türkçe`, `العربية`, each
   written in its own language. Web: `localStorage` key `hz.language` (`src/lib/language.ts`),
   offered in the account menu and as pills on the sign-in page. Phone: AsyncStorage key
   `ops.language` (`src/i18n/languagePreference.ts`), offered in Profile. Neither is sent to the
   API, and neither changes `User.locale`.
3. **Switching at runtime.** Web: an inline script sets `lang` and `dir` on `<html>` before the
   first paint (`LANGUAGE_INIT_SCRIPT`); `LanguageGate` renders nothing on the server, sets the
   language with `setLocale` before its children render, and remounts them on a change, so no
   English page is sent and then swapped. Phone: `LanguageProvider` loads the choice, calls
   `setLanguage`, and remounts the app; React Native applies a change of layout direction (to or
   from Arabic) only on the next start of the app, and Profile says so.
4. **Arabic** is right to left with Latin digits (`ar-u-nu-latn`) in both apps; the dashboard
   uses IBM Plex Sans Arabic for Arabic text.
5. **Unchanged**: `User.locale` still chooses the language of the server-rendered notifications
   (whose catalogue is English only), and of the daily summary narrative; the browser-tab titles
   (Next.js metadata) stay English.

## Reasons

- The sign-in and activation pages need a language before a user is known; a device preference
  serves them and the signed-in screens with one rule.
- No API change, no extra request before the first paint, and it works on the phone offline.
- It mirrors the theme choice of 2026-11-16, so both apps treat appearance settings the same way.

## Tradeoffs

- A user who signs in on another browser or phone chooses again.
- The interface language and `User.locale` can differ, so a user may read the dashboard in Arabic
  and receive notifications rendered for `en` (today all notification text is English anyway).
- The web renders nothing until the browser has run (`LanguageGate`); acceptable because every
  page except sign-in and activation is behind sign-in.

## Alternatives considered

- **`User.locale` as ADR-0009 planned**: the sign-in pages would still need a device rule, and
  the language would be known only after `/auth/me`, so the first paint would be in the wrong
  language or wait for the network.
- **Server rendering in the chosen language (a cookie read by Next.js)**: would put a language
  decision into every server render for pages that are client-rendered behind sign-in anyway.

## Consequences

- Every new user-facing key needs a Turkish and an Arabic text in both apps (the typecheck
  enforces it).
- Linking the device choice and `User.locale` (for example writing the choice back to the user)
  stays open; it matters once notifications and summaries have Turkish and Arabic texts.
- No review of the Turkish and Arabic texts by a native speaker is recorded (as of 2026-11-17).
