import { Ionicons } from '@expo/vector-icons';
import { colors, fontSizes, fontWeights, spacing } from '@ops/shared';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from '@react-navigation/native-stack';
import type { ComponentProps } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { touch } from '../components/sizes';
import { useNotifications } from '../data/queries';
import { t } from '../i18n';
import { HomeScreen } from '../screens/HomeScreen';
import { LogDetailScreen } from '../screens/LogDetailScreen';
import { LogFormScreen } from '../screens/LogFormScreen';
import { LogsScreen } from '../screens/LogsScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { PhotoViewerScreen } from '../screens/PhotoViewerScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { TaskDetailScreen } from '../screens/TaskDetailScreen';
import { TasksScreen } from '../screens/TasksScreen';
import type { SignedInStackParamList, TabParamList } from './types';

const Stack = createNativeStackNavigator<SignedInStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

type IconName = ComponentProps<typeof Ionicons>['name'];

const TAB_ICONS: Record<keyof TabParamList, [IconName, IconName]> = {
  Home: ['home', 'home-outline'],
  Tasks: ['checkbox', 'checkbox-outline'],
  Logs: ['document-text', 'document-text-outline'],
  Notifications: ['notifications', 'notifications-outline'],
  Profile: ['person-circle', 'person-circle-outline'],
};

export const headerOptions: NativeStackNavigationOptions = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.primary,
  headerTitleStyle: {
    color: colors.textPrimary,
    fontWeight: fontWeights.semibold,
    fontSize: fontSizes.lg,
  },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.background },
};

function TabNavigator() {
  const insets = useSafeAreaInsets();
  const notifications = useNotifications();
  const unread = notifications.data?.unreadCount ?? 0;
  const tabBarHeight = touch.primary + insets.bottom;

  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: colors.background },
        headerTitleStyle: {
          color: colors.textPrimary,
          fontWeight: fontWeights.semibold,
          fontSize: fontSizes.lg,
        },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarStyle: {
          height: tabBarHeight,
          paddingTop: spacing.xs,
          paddingBottom: Math.max(insets.bottom, spacing.xs),
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        tabBarItemStyle: { minHeight: touch.min },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarLabelStyle: { fontSize: fontSizes.xs, fontWeight: fontWeights.semibold },
        tabBarIcon: ({ focused, color, size }) => (
          <Ionicons name={TAB_ICONS[route.name][focused ? 0 : 1]} color={color} size={size} />
        ),
      })}
    >
      <Tabs.Screen name="Home" component={HomeScreen} options={{ title: t('tabs.home') }} />
      <Tabs.Screen
        name="Tasks"
        component={TasksScreen}
        options={{ title: t('tasks.title'), tabBarLabel: t('tabs.tasks') }}
      />
      <Tabs.Screen
        name="Logs"
        component={LogsScreen}
        options={{ title: t('logs.title'), tabBarLabel: t('tabs.logs') }}
      />
      <Tabs.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{
          title: t('notifications.title'),
          tabBarLabel: t('tabs.notifications'),
          tabBarAccessibilityLabel:
            unread > 0
              ? `${t('tabs.notificationsLabel')}, ${t('tabs.unreadBadge', { count: unread })}`
              : t('tabs.notificationsLabel'),
          tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.primary,
            color: colors.onPrimary,
            fontWeight: fontWeights.bold,
          },
        }}
      />
      <Tabs.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ title: t('profile.title'), tabBarLabel: t('tabs.profile') }}
      />
    </Tabs.Navigator>
  );
}

/** The signed-in app: the tabs, with the detail screens stacked above them. */
export function SignedInNavigator() {
  return (
    <Stack.Navigator screenOptions={headerOptions}>
      <Stack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
      <Stack.Screen
        name="TaskDetail"
        component={TaskDetailScreen}
        options={{ title: t('tasks.detailTitle') }}
      />
      <Stack.Screen
        name="LogForm"
        component={LogFormScreen}
        options={{ title: t('logForm.titleNew') }}
      />
      <Stack.Screen
        name="LogDetail"
        component={LogDetailScreen}
        options={{ title: t('logs.detailTitle') }}
      />
      <Stack.Screen
        name="PhotoViewer"
        component={PhotoViewerScreen}
        options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade' }}
      />
    </Stack.Navigator>
  );
}
