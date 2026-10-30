import type { ReactNode } from 'react';

import { AppShell } from '@/components/shell/app-shell';

/**
 * Every dashboard page (Phase 6). The route guard in `AuthProvider` renders this only for a
 * signed-in user; the shell adds navigation, the account menu and the role check (UX only).
 */
export default function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
