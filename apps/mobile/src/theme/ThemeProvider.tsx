import { darkTheme, type ThemeColors } from '@ops/shared';
import * as SystemUI from 'expo-system-ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';

import { deviceStore } from '../storage/deviceStore';
import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  type ThemePreference,
} from './themePreference';

export interface ThemeState {
  colors: ThemeColors;
  scheme: 'light' | 'dark';
  preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
}

// Outside the provider (never in the app) the brand's dark theme applies.
const ThemeContext = createContext<ThemeState>({
  colors: darkTheme.colors,
  scheme: darkTheme.scheme,
  preference: 'system',
  setPreference: () => undefined,
});

/**
 * The colour theme of the whole app: the phone's light or dark setting (live), unless the worker
 * chose Dark or Light in Profile. The choice is remembered on this phone.
 */
export function ThemeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const device = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    let active = true;
    void loadThemePreference(deviceStore).then((stored) => {
      // A choice made while the stored one was loading wins.
      if (active) setPreferenceState((current) => (current === 'system' ? stored : current));
    });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    void saveThemePreference(deviceStore, next);
  }, []);

  const value = useMemo<ThemeState>(() => {
    const theme = resolveTheme(preference, device);
    return { colors: theme.colors, scheme: theme.scheme, preference, setPreference };
  }, [preference, device, setPreference]);

  // The native root view behind the app (seen during keyboard and screen transitions).
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(value.colors.background).catch(() => undefined);
  }, [value.colors.background]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
