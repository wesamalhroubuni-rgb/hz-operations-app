import type { ThemeColors } from '@ops/shared';
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { apiClient } from './src/api/client';
import { AuthProvider, useAuth } from './src/auth/AuthProvider';
import { DataProvider } from './src/data/DataProvider';
import { deleteLocalFile } from './src/device/files';
import { applyLayoutDirection } from './src/i18n';
import { flushPendingTarget, navigationRef } from './src/navigation/navigationRef';
import { rootViewFor } from './src/navigation/screen';
import { SignedInNavigator } from './src/navigation/SignedInNavigator';
import { SignedOutNavigator } from './src/navigation/SignedOutNavigator';
import { PushProvider } from './src/push/usePush';
import { LoadingScreen } from './src/screens/LoadingScreen';
import { deviceStore } from './src/storage/deviceStore';
import { purgeStaleLocalDataOnce } from './src/storage/retention';
import { ThemeProvider, useTheme } from './src/theme';

applyLayoutDirection();
// At app start, with or without a session: drafts and queued uploads older than 14 days go,
// for every user of the phone (src/storage/retention.ts).
void purgeStaleLocalDataOnce({ store: deviceStore, deleteLocalFile });

/** React Navigation's light or dark theme in the brand's tokens. */
function navigationThemeFor(scheme: 'light' | 'dark', colors: ThemeColors): Theme {
  const base = scheme === 'light' ? DefaultTheme : DarkTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.surface,
      text: colors.textPrimary,
      border: colors.border,
      notification: colors.primary,
    },
  };
}

/**
 * The sign-in state picks the navigator (see `src/navigation/types.ts` for the map). The signed-in
 * part is keyed by the user, so another user starts with an empty cache and their own drafts.
 */
function Root() {
  const { state } = useAuth();
  const view = rootViewFor(state.status);
  const { colors, scheme } = useTheme();
  const navigationTheme = useMemo(() => navigationThemeFor(scheme, colors), [scheme, colors]);

  if (view === 'loading') {
    return <LoadingScreen />;
  }

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navigationTheme}
      onReady={flushPendingTarget}
      onStateChange={flushPendingTarget}
    >
      {state.status === 'signedIn' && apiClient !== null ? (
        <DataProvider key={state.user.id} user={state.user} client={apiClient}>
          <PushProvider>
            <SignedInNavigator />
          </PushProvider>
        </DataProvider>
      ) : (
        <SignedOutNavigator />
      )}
    </NavigationContainer>
  );
}

/** The status bar icons contrast with the theme: light on dark, dark on light. */
function ThemedFrame({ children }: Readonly<{ children: ReactNode }>) {
  const { colors, scheme } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {children}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedFrame>
          <AuthProvider>
            <Root />
          </AuthProvider>
        </ThemedFrame>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
