import type { AppNotification } from '@ops/shared';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback } from 'react';

import { useRepositories } from '../data/DataProvider';
import { notificationTarget } from '../logic/notificationRouting';
import type { SignedInStackParamList } from '../navigation/types';

/**
 * Opening a notification from the list: mark it read (without waiting) and go to the task or log
 * it is about.
 */
export function useOpenNotification() {
  const repositories = useRepositories();
  const navigation = useNavigation<NativeStackNavigationProp<SignedInStackParamList>>();
  return useCallback(
    (notification: AppNotification) => {
      if (notification.readAt === null) {
        void repositories.notifications.markRead(notification.id);
      }
      const target = notificationTarget(notification.data, notification.type);
      if (target?.screen === 'TaskDetail') navigation.navigate('TaskDetail', target.params);
      if (target?.screen === 'LogDetail') navigation.navigate('LogDetail', target.params);
    },
    [navigation, repositories],
  );
}
