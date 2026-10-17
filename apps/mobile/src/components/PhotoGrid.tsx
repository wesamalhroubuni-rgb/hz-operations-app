import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, type Attachment } from '@ops/shared';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { t } from '../i18n';
import { iconSize, thumbnailSize, touch } from './sizes';

/** The photos of a saved log as thumbnails; tapping one opens it large. */
export function AttachmentGrid({
  attachments,
  onOpen,
}: Readonly<{
  attachments: readonly Attachment[];
  onOpen: (attachment: Attachment, index: number) => void;
}>) {
  return (
    <View style={styles.grid}>
      {attachments.map((attachment, index) => {
        const label = t('logs.photoLabel', { index: index + 1, count: attachments.length });
        const source = attachment.thumbnailUrl ?? attachment.url;
        if (attachment.status !== 'ready' || source === null) {
          return (
            <View
              key={attachment.id}
              style={[styles.tile, styles.placeholder]}
              accessible
              accessibilityLabel={t('logs.photoProcessing')}
            >
              <Ionicons name="hourglass-outline" size={iconSize.md} color={colors.textMuted} />
            </View>
          );
        }
        return (
          <Pressable
            key={attachment.id}
            accessibilityRole="imagebutton"
            accessibilityLabel={label}
            onPress={() => onOpen(attachment, index)}
            style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
          >
            <Image source={{ uri: source }} style={styles.image} resizeMode="cover" />
          </Pressable>
        );
      })}
    </View>
  );
}

/** Photos picked for a log that is not saved yet, each with a large remove button. */
export function LocalPhotoGrid({
  photos,
  onRemove,
  onOpen,
}: Readonly<{
  photos: readonly { localId: string; uri: string }[];
  onRemove: (localId: string) => void;
  onOpen: (uri: string, index: number) => void;
}>) {
  return (
    <View style={styles.grid}>
      {photos.map((photo, index) => (
        <View key={photo.localId} style={styles.tileWrap}>
          <Pressable
            accessibilityRole="imagebutton"
            accessibilityLabel={t('logs.photoLabel', { index: index + 1, count: photos.length })}
            onPress={() => onOpen(photo.uri, index)}
            style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
          >
            <Image source={{ uri: photo.uri }} style={styles.image} resizeMode="cover" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('logForm.removePhoto', { index: index + 1 })}
            onPress={() => onRemove(photo.localId)}
            hitSlop={spacing.sm}
            style={({ pressed }) => [styles.remove, pressed && styles.removePressed]}
          >
            <Ionicons name="close" size={iconSize.md} color={colors.textPrimary} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tileWrap: {
    position: 'relative',
  },
  tile: {
    width: thumbnailSize,
    height: thumbnailSize,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    borderColor: colors.primary,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  remove: {
    position: 'absolute',
    top: -spacing.sm,
    end: -spacing.sm,
    width: touch.min - spacing.md,
    height: touch.min - spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
  },
  removePressed: {
    borderColor: colors.primary,
  },
});
