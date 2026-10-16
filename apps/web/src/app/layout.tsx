import { defaultTheme, themeCssVariables } from '@ops/shared';
import type { Metadata, Viewport } from 'next';
import type { CSSProperties, ReactNode } from 'react';

import { AuthProvider } from '@/components/auth-provider';
import { brand } from '@/lib/brand';

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
  themeColor: defaultTheme.colors.background,
  colorScheme: defaultTheme.scheme,
};

// The design tokens become CSS custom properties on <html>; every stylesheet reads them.
const themeVariables = themeCssVariables(defaultTheme) as CSSProperties;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" style={themeVariables}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
