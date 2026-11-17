import { fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { Pressable, Text, View } from 'react-native';

import { t } from '../i18n';
import { makeStyles, THEME_MENU_ORDER, useTheme } from '../theme';
import { AppText } from './AppText';
import { Card } from './Card';
import { touch } from './sizes';

/**
 * The colour theme in Profile: System, Dark, Light (the web dashboard's order), the current one
 * marked with a filled dot. A device preference: it applies at once and is kept on this phone.
 */
export function ThemeChoice() {
  const styles = useStyles();
  const { preference, setPreference } = useTheme();
  const title = t('profile.theme.title');
  return (
    <Card>
      <AppText variant="heading">{title}</AppText>
      <View accessibilityRole="radiogroup" accessibilityLabel={title} style={styles.list}>
        {THEME_MENU_ORDER.map((value) => {
          const selected = preference === value;
          const label = t(`profile.theme.${value}`);
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, selected }}
              accessibilityLabel={`${title}: ${label}`}
              accessibilityHint={value === 'system' ? t('profile.theme.systemHint') : undefined}
              onPress={() => setPreference(value)}
              style={({ pressed }) => [
                styles.option,
                selected && styles.optionSelected,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.radio, selected && styles.radioSelected]}>
                {selected ? <View style={styles.dot} /> : null}
              </View>
              <View style={styles.texts}>
                <Text style={styles.label}>{label}</Text>
                {value === 'system' ? (
                  <AppText variant="small">{t('profile.theme.systemHint')}</AppText>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

const RADIO_SIZE = 22;
const DOT_SIZE = 10;

const useStyles = makeStyles((colors) => ({
  list: {
    gap: spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.comfortable,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  optionSelected: {
    borderColor: colors.primary,
  },
  pressed: {
    borderColor: colors.primary,
  },
  radio: {
    width: RADIO_SIZE,
    height: RADIO_SIZE,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {
    borderColor: colors.primary,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
  },
  texts: {
    flex: 1,
    gap: spacing.xs / 2,
  },
  label: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    color: colors.textPrimary,
  },
}));
