import {
  AUTH_TEXT,
  colors,
  fontSizes,
  fontWeights,
  radii,
  roleLabel,
  spacing,
  type AuthUser,
} from '@ops/shared';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiStatusCard } from '../components/ApiStatusCard';
import { BrandHeader } from '../components/BrandHeader';
import { Button } from '../components/Button';
import { Message } from '../components/Message';
import { brand } from '../config/brand';
import { useSignOut } from '../hooks/useSignOut';

/**
 * The placeholder home screen of a signed-in user: who they are, whether the API answers, and
 * the two ways out. Work logging comes in Phase 4.
 */
export function HomeScreen({ user }: Readonly<{ user: AuthUser }>) {
  const { busy, failure, run } = useSignOut();

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <BrandHeader />

        <View style={styles.card}>
          <Text style={styles.cardHeading}>{AUTH_TEXT.signedInAs}</Text>
          <View accessible style={styles.identity}>
            <Text style={styles.name}>{user.displayName}</Text>
            <View style={styles.roleRow}>
              <Text style={styles.badge}>{roleLabel(user.role)}</Text>
              <Text style={styles.organization}>{user.organizationName}</Text>
            </View>
          </View>

          {failure !== null ? <Message tone="error" text={failure} /> : null}

          <Button
            label={busy === 'device' ? AUTH_TEXT.signingOut : AUTH_TEXT.signOut}
            onPress={() => void run('device')}
            disabled={busy !== null}
            busy={busy === 'device'}
          />
          <Button
            variant="secondary"
            label={busy === 'everywhere' ? AUTH_TEXT.signingOut : AUTH_TEXT.signOutEverywhere}
            onPress={() => void run('everywhere')}
            disabled={busy !== null}
            busy={busy === 'everywhere'}
            accessibilityHint={AUTH_TEXT.signOutEverywhereHint}
          />
          <Text style={styles.hint}>
            {`${AUTH_TEXT.signOutEverywhere}: ${AUTH_TEXT.signOutEverywhereHint}`}
          </Text>
        </View>

        <ApiStatusCard />

        <Text style={styles.poweredBy}>{brand.poweredBy}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  cardHeading: {
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.semibold,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  identity: {
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  name: {
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.semibold,
    color: colors.textPrimary,
  },
  roleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
  },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs / 2,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.pill,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    color: colors.primary,
    overflow: 'hidden',
  },
  organization: {
    flexShrink: 1,
    fontSize: fontSizes.md,
    color: colors.textSecondary,
  },
  hint: {
    fontSize: fontSizes.xs,
    color: colors.textMuted,
  },
  poweredBy: {
    fontSize: fontSizes.xs,
    textAlign: 'center',
    color: colors.textMuted,
  },
});
