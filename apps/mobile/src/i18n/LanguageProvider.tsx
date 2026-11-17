import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { deviceStore } from '../storage/deviceStore';
import {
  applyLayoutDirection,
  currentLanguage,
  deviceLanguage,
  setLanguage,
  type LanguageCode,
} from './index';
import {
  loadLanguagePreference,
  saveLanguagePreference,
  type LanguagePreference,
} from './languagePreference';

export interface LanguageState {
  /** The language in force. */
  language: LanguageCode;
  /** The worker's choice in Profile (`system` follows the phone). */
  preference: LanguagePreference;
  setPreference(preference: LanguagePreference): void;
  /** True when the layout direction changes only after the app is reopened (to or from Arabic). */
  restartNeeded: boolean;
}

const LanguageContext = createContext<LanguageState>({
  language: 'en',
  preference: 'system',
  setPreference: () => undefined,
  restartNeeded: false,
});

function resolve(preference: LanguagePreference): LanguageCode {
  return preference === 'system' ? deviceLanguage() : preference;
}

/**
 * The language of the whole app: the phone's, unless the worker chose one in Profile (kept on
 * this phone). `children` is a render function keyed by the language, so every screen re-reads
 * its text when the language changes.
 */
export function LanguageProvider({
  children,
}: Readonly<{ children: (language: LanguageCode) => ReactNode }>) {
  const [preference, setPreferenceState] = useState<LanguagePreference>('system');
  const [language, setLanguageState] = useState<LanguageCode>(currentLanguage());
  const [restartNeeded, setRestartNeeded] = useState(false);

  const applyPreference = useCallback((next: LanguagePreference) => {
    const code = resolve(next);
    setLanguage(code);
    setLanguageState(code);
    setRestartNeeded(applyLayoutDirection());
  }, []);

  useEffect(() => {
    let active = true;
    void loadLanguagePreference(deviceStore).then((stored) => {
      if (!active) return;
      setPreferenceState(stored);
      applyPreference(stored);
    });
    return () => {
      active = false;
    };
  }, [applyPreference]);

  const setPreference = useCallback(
    (next: LanguagePreference) => {
      setPreferenceState(next);
      applyPreference(next);
      void saveLanguagePreference(deviceStore, next);
    },
    [applyPreference],
  );

  const value = useMemo<LanguageState>(
    () => ({ language, preference, setPreference, restartNeeded }),
    [language, preference, setPreference, restartNeeded],
  );

  return <LanguageContext.Provider value={value}>{children(language)}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageState {
  return useContext(LanguageContext);
}
