import { spacing } from '@ops/shared';
import { Pressable, View } from 'react-native';

import { makeStyles } from '../theme';
import { AppText } from './AppText';
import { touch } from './sizes';

/** A section title with an optional link at the end ("See all"). */
export function SectionHeader({
  title,
  actionLabel,
  onAction,
}: Readonly<{ title: string; actionLabel?: string; onAction?: () => void }>) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <AppText variant="heading" style={styles.title}>
        {title}
      </AppText>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="link"
          onPress={onAction}
          hitSlop={spacing.sm}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <AppText variant="label" style={styles.actionText}>
            {actionLabel}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  title: {
    flex: 1,
  },
  action: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  pressed: {
    opacity: 0.6,
  },
  actionText: {
    color: colors.primary,
  },
}));
