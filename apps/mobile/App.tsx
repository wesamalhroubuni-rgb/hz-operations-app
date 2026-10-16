import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from './src/auth/AuthProvider';
import { screenFor, type SignedOutScreen } from './src/navigation/screen';
import { ActivateScreen } from './src/screens/ActivateScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { LoadingScreen } from './src/screens/LoadingScreen';
import { LoginScreen } from './src/screens/LoginScreen';

/**
 * The whole navigation of this phase: the sign-in state picks the screen, and a signed-out user
 * can switch between the sign-in form and the activation form. A navigation library comes with
 * the feature screens in Phase 4.
 */
function Screens() {
  const { state, retry } = useAuth();
  const [chosen, setChosen] = useState<SignedOutScreen>('login');
  const [passwordSet, setPasswordSet] = useState(false);

  // The "password set" notice belongs to the sign-in that follows it, not to later ones.
  if (state.status === 'signedIn' && passwordSet) {
    setPasswordSet(false);
  }

  const showLogin = useCallback(() => setChosen('login'), []);
  const showActivate = useCallback(() => {
    setPasswordSet(false);
    setChosen('activate');
  }, []);
  const passwordWasSet = useCallback(() => {
    setPasswordSet(true);
    setChosen('login');
  }, []);

  switch (screenFor(state.status, chosen)) {
    case 'loading':
      return <LoadingScreen />;
    case 'home':
      return state.status === 'signedIn' ? <HomeScreen user={state.user} /> : null;
    case 'activate':
      return <ActivateScreen onDone={passwordWasSet} onBack={showLogin} />;
    case 'login':
      return (
        <LoginScreen
          notice={state.status === 'signedOut' ? state.notice : null}
          passwordSet={passwordSet}
          onRetry={retry}
          onHaveCode={showActivate}
        />
      );
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <Screens />
      </AuthProvider>
      {/* Light status bar icons: the brand theme is dark. */}
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
