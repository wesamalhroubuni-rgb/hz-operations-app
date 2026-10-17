import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { ActivateScreen } from '../screens/ActivateScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { headerOptions } from './SignedInNavigator';
import type { SignedOutStackParamList } from './types';

const Stack = createNativeStackNavigator<SignedOutStackParamList>();

/** Sign-in and activation. The Android back button on Activate returns to sign-in. */
export function SignedOutNavigator() {
  return (
    <Stack.Navigator screenOptions={{ ...headerOptions, headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Activate" component={ActivateScreen} />
    </Stack.Navigator>
  );
}
