import logo from '../../assets/brand/logo-512.png';
import logoMark from '../../assets/brand/logo-mark.png';
import { t } from '../i18n';
import { env } from './env';

/**
 * Everything that identifies the client this build is branded for. Screens read the brand from
 * here and never spell out a client name.
 *
 * To re-brand for another client: set EXPO_PUBLIC_BRAND_NAME and replace the files in
 * `assets/brand/` (same names, same sizes). `app.config.ts` uses the same name and files for the
 * app name, icon, adaptive icon and splash screen. Colours come from the design tokens in
 * `@ops/shared`.
 *
 * The labels are getters, so they follow the language chosen in Profile.
 */
export const brand = {
  /** The client's product name. */
  name: env.brandName,
  /** What this app is, shown next to the name. */
  get appLabel(): string {
    return t('common.appLabel');
  },
  logo: {
    source: logo,
    /** The emblem cropped to its ring, for in-app use on the black brand areas (readable small). */
    mark: logoMark,
    get accessibilityLabel(): string {
      return t('common.logoLabel', { brand: env.brandName });
    },
  },
};
