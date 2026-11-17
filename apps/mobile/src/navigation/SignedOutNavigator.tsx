import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { ActivateScreen } from '../screens/ActivateScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { useHeaderOptions } from './SignedInNavigator';
import type { SignedOutStackParamList } from './types';

const Stack = createNativeStackNavigator<SignedOutStackParamList>();

/** Sign-in and activation. The Android back button on Activate returns to sign-in. */
export function SignedOutNavigator() {
  const headerOptions = useHeaderOptions();
  return (
    <Stack.Navigator screenOptions={{ ...headerOptions, headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Activate" component={ActivateScreen} />
    </Stack.Navigator>
  );
}
