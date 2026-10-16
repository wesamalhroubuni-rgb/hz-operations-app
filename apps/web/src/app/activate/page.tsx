import { AUTH_TEXT } from '@ops/shared';
import type { Metadata } from 'next';

import { ActivateForm } from '@/components/activate-form';
import { AuthShell } from '@/components/auth-shell';
import { CODE_PARAM } from '@/lib/auth/routes';

export const metadata: Metadata = {
  title: AUTH_TEXT.activateTitle,
  // An activation link is personal: keep it out of search engines and link previews.
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Activation and password reset. The one-time code may arrive as `?code=` in a link; the form
 * removes it from the address bar as soon as it has it, and `next.config.ts` sends this page with
 * `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
 */
export default async function ActivatePage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const code = (await searchParams)[CODE_PARAM];
  return (
    <AuthShell title={AUTH_TEXT.activateTitle} intro={AUTH_TEXT.activateIntro}>
      <ActivateForm initialCode={typeof code === 'string' ? code.slice(0, 200) : ''} />
    </AuthShell>
  );
}
