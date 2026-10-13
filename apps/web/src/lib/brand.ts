import { env } from './env';

/**
 * Everything that identifies the client this deployment is branded for. Components, page titles
 * and metadata read the brand from here and never spell out a client name.
 *
 * To re-brand for another client: set NEXT_PUBLIC_BRAND_NAME, replace the image files named
 * below (same names, same sizes), and replace `src/app/icon.png` and `src/app/apple-icon.png`
 * (the favicon and Apple touch icon, which Next.js picks up by file name). Colours come from
 * the design tokens in `@ops/shared`.
 */
export const brand = {
  /** The client's product name. */
  name: env.brandName,
  /** What this app is, shown next to the name. */
  appLabel: 'Manager dashboard',
  /** Square logo served from `public/brand/`. */
  logo: {
    src: '/brand/logo-512.png',
    width: 512,
    height: 512,
    alt: `${env.brandName} logo`,
  },
  /** The only mention of the company that builds the product. Keep it small. */
  poweredBy: 'Powered by Kaneri.ai',
} as const;
