import { colors, spacing } from '@ops/shared';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ScreenContainerProps {
  children: ReactNode;
  /**
   * The screen's main actions, pinned to the bottom where a thumb reaches them, above the
   * keyboard when it is open.
   */
  footer?: ReactNode;
  /** Pull to refresh. */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** When the header of a stack sits above the screen, the keyboard offset accounts for it. */
  keyboardOffset?: number;
  /** Inside the tab navigator the tab bar already keeps clear of the home indicator. */
  inTab?: boolean;
}

/** The frame of a signed-in screen: scrolling content and an optional bottom action bar. */
export function ScreenContainer({
  children,
  footer,
  refreshing,
  onRefresh,
  keyboardOffset = 0,
  inTab = false,
}: Readonly<ScreenContainerProps>) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      // Android draws edge to edge (SDK 57), so the window does not resize for the keyboard:
      // padding is right on both platforms.
      behavior="padding"
      keyboardVerticalOffset={keyboardOffset}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing ?? false}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surface}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
      {footer ? (
        <View
          style={[
            styles.footer,
            { paddingBottom: inTab ? spacing.md : Math.max(insets.bottom, spacing.md) },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  footer: {
    gap: spacing.sm,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
});
