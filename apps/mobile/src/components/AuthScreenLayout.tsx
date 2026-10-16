import { colors, fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { brand } from '../config/brand';
import { BrandHeader } from './BrandHeader';

/**
 * The frame of the sign-in and activation screens: the brand above one card. The content scrolls
 * and moves out of the keyboard's way, so the field being typed in and the button stay reachable
 * on a small phone.
 */
export function AuthScreenLayout({
  title,
  intro,
  children,
}: Readonly<{ title: string; intro?: string; children: ReactNode }>) {
  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <BrandHeader compact />
          <View style={styles.card}>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            {intro ? <Text style={styles.intro}>{intro}</Text> : null}
            {children}
          </View>
          <Text style={styles.poweredBy}>{brand.poweredBy}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  card: {
    gap: spacing.lg,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  title: {
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.semibold,
    color: colors.textPrimary,
  },
  intro: {
    fontSize: fontSizes.sm,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  poweredBy: {
    fontSize: fontSizes.xs,
    textAlign: 'center',
    color: colors.textMuted,
  },
});
