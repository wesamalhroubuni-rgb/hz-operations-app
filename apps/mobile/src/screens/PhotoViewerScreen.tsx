import { colors, spacing } from '@ops/shared';
import { Image, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../components/Button';
import { t } from '../i18n';
import type { StackScreenProps } from '../navigation/types';

/** One photo, full screen, with a large close button at the bottom. */
export function PhotoViewerScreen({
  route,
  navigation,
}: Readonly<StackScreenProps<'PhotoViewer'>>) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, spacing.md) },
      ]}
    >
      <Image
        source={{ uri: route.params.uri }}
        style={styles.image}
        resizeMode="contain"
        accessible
        accessibilityRole="image"
        accessibilityLabel={route.params.title}
      />
      <View style={styles.footer}>
        <Button
          variant="secondary"
          size="large"
          icon="close"
          label={t('common.close')}
          onPress={() => navigation.goBack()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  image: {
    flex: 1,
    width: '100%',
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
});
