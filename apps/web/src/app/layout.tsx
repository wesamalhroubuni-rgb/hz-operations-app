import { darkTheme, lightTheme } from '@ops/shared';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';

import { AuthProvider } from '@/components/auth-provider';
import { QueryProvider } from '@/components/query-provider';
import { DIRECTION, LOCALE } from '@/i18n';
import { brand } from '@/lib/brand';
import { THEME_INIT_SCRIPT, themeStylesheet } from '@/lib/theme';

import './globals.css';

// The favicon and Apple touch icon come from `icon.png` and `apple-icon.png` in this folder.
export const metadata: Metadata = {
  title: {
    default: `${brand.name} · ${brand.appLabel}`,
    template: `%s · ${brand.name}`,
  },
  description: `${brand.appLabel} for ${brand.name}.`,
  applicationName: brand.name,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: darkTheme.colors.background },
    { media: '(prefers-color-scheme: light)', color: lightTheme.colors.background },
  ],
  colorScheme: 'dark light',
};

// The design tokens become CSS custom properties on the root element; every stylesheet reads
// them. Dark by default, light when the device prefers it, or the user's choice in the top bar
// (`lib/theme.ts`), applied before the first paint by the inline script.
const themeStyles = themeStylesheet();

// Inter, self-hosted by Next.js at build time (no request to Google from the browser). Latin
// Extended covers Turkish.
const sans = Inter({ subsets: ['latin', 'latin-ext'], variable: '--font-sans', display: 'swap' });

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // The init script may set data-theme before React hydrates.
    <html lang={LOCALE} dir={DIRECTION} className={sans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <style>{themeStyles}</style>
      </head>
      <body>
        <AuthProvider>
          <QueryProvider>{children}</QueryProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
