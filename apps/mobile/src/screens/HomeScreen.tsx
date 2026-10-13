import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { env, MISSING_API_URL_MESSAGE } from '../config/env';
import { useApiHealth, type ApiHealthState } from '../hooks/useApiHealth';

const COLORS = {
  background: '#F5F7FA',
  card: '#FFFFFF',
  border: '#D9DEE5',
  text: '#16202B',
  muted: '#5B6877',
  ok: '#1E8E4E',
  warn: '#B7791F',
  error: '#C0392B',
  button: '#1F4FD8',
  buttonText: '#FFFFFF',
} as const;

interface StatusLine {
  label: string;
  detail: string;
  color: string;
}

function describe(state: ApiHealthState): StatusLine {
  if (state.phase === 'not-configured') {
    return { label: 'API not configured', detail: MISSING_API_URL_MESSAGE, color: COLORS.error };
  }
  if (state.phase === 'loading') {
    return { label: 'Checking API…', detail: '', color: COLORS.muted };
  }
  const { result } = state;
  if (!result.reachable) {
    return { label: 'API unreachable', detail: result.message, color: COLORS.error };
  }
  if (result.health.database === 'up') {
    return { label: 'API reachable', detail: 'Database: up', color: COLORS.ok };
  }
  return { label: 'API reachable', detail: 'Database: down', color: COLORS.warn };
}

export function HomeScreen() {
  const { state, retry } = useApiHealth(env.apiUrl);
  const status = describe(state);
  const isLoading = state.phase === 'loading';

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Operations App</Text>
        <Text style={styles.subtitle}>Worker app — Phase 1 placeholder</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardHeading}>API status</Text>
        <View style={styles.statusRow}>
          {isLoading ? (
            <ActivityIndicator color={COLORS.muted} />
          ) : (
            <View style={[styles.dot, { backgroundColor: status.color }]} />
          )}
          <Text style={[styles.statusLabel, { color: status.color }]}>{status.label}</Text>
        </View>
        {status.detail ? <Text style={styles.detail}>{status.detail}</Text> : null}
        {env.apiUrl ? <Text style={styles.url}>{env.apiUrl}</Text> : null}

        <Pressable
          accessibilityRole="button"
          disabled={isLoading || !env.apiUrl}
          onPress={retry}
          style={({ pressed }) => [
            styles.button,
            (isLoading || !env.apiUrl) && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
    paddingHorizontal: 20,
    justifyContent: 'center',
    gap: 24,
  },
  header: {
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.text,
  },
  subtitle: {
    fontSize: 15,
    color: COLORS.muted,
  },
  card: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  cardHeading: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.muted,
    textTransform: 'uppercase',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 24,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  statusLabel: {
    fontSize: 18,
    fontWeight: '600',
  },
  detail: {
    fontSize: 14,
    color: COLORS.text,
  },
  url: {
    fontSize: 12,
    color: COLORS.muted,
  },
  button: {
    marginTop: 6,
    backgroundColor: COLORS.button,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonText: {
    color: COLORS.buttonText,
    fontSize: 16,
    fontWeight: '600',
  },
});
