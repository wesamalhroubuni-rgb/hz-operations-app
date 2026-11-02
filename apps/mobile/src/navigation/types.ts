import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

// The navigation map of the app.
//
// Signed out (stack): Login -> Activate.
// Signed in (stack):  Tabs [Home | Tasks | Logs | Notifications | Profile]
//                     + TaskDetail, LogForm (new or edit), LogDetail, PhotoViewer, Sync above the tabs.

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

/**
 * `captureClientId` (Phase 7): the form reviews a smart capture: filled from its proposal, with
 * the transcript, the AI-suggested marker and confidence hints; saving confirms it.
 */
export type LogFormParams =
  { mode: 'new'; taskId?: string; captureClientId?: string } | { mode: 'edit'; logId: string };

/** Phase 7: "Speak", "Snap" or "Type a note" for a smart capture. */
export type CaptureParams = { kind: 'voice' | 'photo' | 'text'; taskId?: string };

export type SignedInStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  TaskDetail: { taskId: string };
  LogForm: LogFormParams;
  LogDetail: { logId: string };
  PhotoViewer: { uri: string; title: string };
  /** Phase 5: what is on this phone and not yet accepted by the server. */
  Sync: undefined;
  /** Phase 7: record, snap or type a smart capture. */
  Capture: CaptureParams;
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
