import { fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import type { ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { brand } from '../config/brand';
import { makeStyles } from '../theme';

/**
 * The frame of the sign-in and activation screens: a black brand hero (the logo sits on its own
 * black, so it shows no tile) and one card below it. The content scrolls and moves out of the
 * keyboard's way, so the field being typed in and the button stay reachable on a small phone.
 */
export function AuthScreenLayout({
  title,
  intro,
  children,
}: Readonly<{ title: string; intro?: string; children: ReactNode }>) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.hero, { paddingTop: insets.top + spacing.xxl }]}>
            <Image
              source={brand.logo.source}
              style={styles.logo}
              accessible
              accessibilityRole="image"
              accessibilityLabel={brand.logo.accessibilityLabel}
            />
            <Text style={styles.appLabel}>{brand.appLabel}</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            {intro ? <Text style={styles.intro}>{intro}</Text> : null}
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  hero: {
    alignItems: 'center',
    gap: spacing.md,
    paddingBottom: spacing.xxxl + spacing.xl,
    backgroundColor: colors.brandInk,
    borderBottomStartRadius: radii.lg * 2,
    borderBottomEndRadius: radii.lg * 2,
  },
  logo: {
    width: 120,
    height: 120,
  },
  appLabel: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.onBrandInkMuted,
  },
  // The card overlaps the hero's lower edge.
  card: {
    gap: spacing.lg,
    marginTop: -spacing.xxxl,
    marginHorizontal: spacing.lg,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  title: {
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
    color: colors.textPrimary,
  },
  intro: {
    fontSize: fontSizes.sm,
    lineHeight: 20,
    color: colors.textSecondary,
  },
}));
