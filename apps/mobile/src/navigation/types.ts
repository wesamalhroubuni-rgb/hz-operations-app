import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

// The navigation map of the app.
//
// Signed out (stack): Login -> Activate.
// Signed in (stack):  Tabs [Home | Tasks | Logs | Notifications | Profile]
//                     + TaskDetail, LogForm (new or edit), LogDetail, PhotoViewer above the tabs.

export type SignedOutStackParamList = {
  Login: { passwordSet?: boolean } | undefined;
  Activate: undefined;
};

export type TabParamList = {
  Home: undefined;
  Tasks: undefined;
  Logs: undefined;
  Notifications: undefined;
  Profile: undefined;
};

export type LogFormParams = { mode: 'new'; taskId?: string } | { mode: 'edit'; logId: string };

export type SignedInStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  TaskDetail: { taskId: string };
  LogForm: LogFormParams;
  LogDetail: { logId: string };
  PhotoViewer: { uri: string; title: string };
};

export type SignedOutScreenProps<Name extends keyof SignedOutStackParamList> =
  NativeStackScreenProps<SignedOutStackParamList, Name>;

export type StackScreenProps<Name extends keyof SignedInStackParamList> = NativeStackScreenProps<
  SignedInStackParamList,
  Name
>;

export type TabScreenProps<Name extends keyof TabParamList> = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, Name>,
  NativeStackScreenProps<SignedInStackParamList>
>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- React Navigation's typing hook
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging
    interface RootParamList extends SignedInStackParamList {}
  }
}
