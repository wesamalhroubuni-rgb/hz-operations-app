import logo from '../../assets/brand/logo-512.png';
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
 */
export const brand = {
  /** The client's product name. */
  name: env.brandName,
  /** What this app is, shown next to the name. */
  appLabel: t('common.appLabel'),
  logo: {
    source: logo,
    accessibilityLabel: t('common.logoLabel', { brand: env.brandName }),
  },
  /** The only mention of the company that builds the product. Keep it small. */
  poweredBy: t('common.poweredBy'),
} as const;
