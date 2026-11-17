import { fontSizes, fontWeights, radii, spacing } from '@ops/shared';
import { Pressable, Text, View } from 'react-native';

import { useRepositories } from '../data/DataProvider';
import { LANGUAGE_NAMES, t } from '../i18n';
import { LANGUAGE_PREFERENCES } from '../i18n/languagePreference';
import { useLanguage } from '../i18n/LanguageProvider';
import { makeStyles } from '../theme';
import { AppText } from './AppText';
import { Card } from './Card';
import { touch } from './sizes';

/**
 * The app's language in Profile: System, English, Türkçe, العربية (each in its own language), the
 * current one marked with a filled dot. A device preference: the text changes at once; the layout
 * direction (to or from Arabic) changes when the app is reopened.
 */
export function LanguageChoice() {
  const styles = useStyles();
  const { preference, setPreference, restartNeeded } = useLanguage();
  const repositories = useRepositories();
  // The screen language at once; the account's language (server texts) through the queue.
  const choose = (value: (typeof LANGUAGE_PREFERENCES)[number]) => {
    setPreference(value);
    if (value !== 'system') void repositories.profile.setLanguage(value);
  };
  const title = t('profile.language.title');
  return (
    <Card>
      <AppText variant="heading">{title}</AppText>
      <View accessibilityRole="radiogroup" accessibilityLabel={title} style={styles.list}>
        {LANGUAGE_PREFERENCES.map((value) => {
          const selected = preference === value;
          const label = value === 'system' ? t('profile.language.system') : LANGUAGE_NAMES[value];
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, selected }}
              accessibilityLabel={`${title}: ${label}`}
              accessibilityHint={value === 'system' ? t('profile.language.systemHint') : undefined}
              onPress={() => choose(value)}
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
                  <AppText variant="small">{t('profile.language.systemHint')}</AppText>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {restartNeeded ? (
        <AppText variant="small">{t('profile.language.restartNote')}</AppText>
      ) : null}
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
