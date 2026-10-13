import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { HomeScreen } from './src/screens/HomeScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <HomeScreen />
      {/* Light status bar icons: the brand theme is dark. */}
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
