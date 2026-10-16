import { AUTH_TEXT } from '@ops/shared';
import type { Metadata } from 'next';

import { AuthShell } from '@/components/auth-shell';
import { LoginForm } from '@/components/login-form';
import { NOTICE_PARAM, PASSWORD_SET_NOTICE } from '@/lib/auth/routes';

export const metadata: Metadata = { title: AUTH_TEXT.signInTitle };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const params = await searchParams;
  return (
    <AuthShell title={AUTH_TEXT.signInTitle}>
      <LoginForm passwordSet={params[NOTICE_PARAM] === PASSWORD_SET_NOTICE} />
    </AuthShell>
  );
}
