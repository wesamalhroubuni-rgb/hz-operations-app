'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { t } from '@/i18n';
import { useCaller } from '@/hooks/use-caller';
import { useOrganization } from '@/hooks/use-organization';
import { brand } from '@/lib/brand';
import { navItemFor, routeAccess, visibleNavItems } from '@/lib/navigation';
import { orgTimeGate } from '@/lib/time';

import styles from './shell.module.css';
import { UserMenu } from './user-menu';

const MAIN_ID = 'main-content';

/**
 * The frame of every dashboard page (Phase 6, ADR-0009): navigation by role, the organization
 * name and time zone, the account menu, and the "Powered by Kaneri.ai" footer. It also decides,
 * for the UX only, whether the caller's role may open the page; the API decides for real.
 *
 * Pages render inside a `<Suspense>` boundary, so they may use `useSearchParams`
 * (`useListParams`).
 */
export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const { capabilities } = useCaller();
  const organization = useOrganization();
  const [navOpen, setNavOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    // Navigating closes the narrow-screen navigation panel.
    setLastPath(pathname);
    setNavOpen(false);
  }

  const items = visibleNavItems(capabilities);
  const current = navItemFor(pathname);
  const access = routeAccess(pathname, capabilities);

  let content: ReactNode;
  switch (access) {
    case 'allowed': {
      // Pages show times in the organization's zone: wait for it rather than guess (ADR-0009).
      const gate = orgTimeGate(organization);
      content =
        gate === 'ready' ? (
          <Suspense fallback={<LoadingState />}>{children}</Suspense>
        ) : gate === 'loading' ? (
          <LoadingState />
        ) : (
          <ErrorState error={organization.error} onRetry={() => void organization.refetch()} />
        );
      break;
    }
    case 'not-for-role':
      content = (
        <EmptyState title={t('shell.notForRoleTitle')} description={t('shell.notForRoleBody')} />
      );
      break;
    case 'worker':
      content = <EmptyState title={t('shell.workerTitle')} description={t('shell.workerBody')} />;
      break;
    case 'no-role':
      content = <EmptyState title={t('shell.noRoleTitle')} description={t('shell.noRoleBody')} />;
      break;
  }

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href={`#${MAIN_ID}`}>
        {t('shell.skipToContent')}
      </a>

      <aside
        id="dashboard-navigation"
        className={`${styles.sidebar} ${navOpen ? styles.sidebarOpen : ''}`}
      >
        <Link href="/" className={styles.brand}>
          <Image
            className={styles.brandLogo}
            src={brand.logo.src}
            width={brand.logo.width}
            height={brand.logo.height}
            alt={t('common.logoLabel', { brand: brand.name })}
            sizes="36px"
            priority
          />
          <span className={styles.brandName}>
            {brand.name}
            <span className={styles.brandLabel}>{t('common.appLabel')}</span>
          </span>
        </Link>
        <nav className={styles.nav} aria-label={t('nav.label')}>
          <ul>
            {items.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className={styles.navLink}
                  aria-current={current?.key === item.key ? 'page' : undefined}
                >
                  {t(item.label)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {navOpen ? (
          <Button variant="ghost" size="sm" onClick={() => setNavOpen(false)}>
            {t('nav.closeMenu')}
          </Button>
        ) : null}
      </aside>

      <div className={styles.column}>
        <header className={styles.topbar}>
          <Button
            className={styles.menuToggle}
            variant="secondary"
            size="sm"
            aria-expanded={navOpen}
            aria-controls="dashboard-navigation"
            onClick={() => setNavOpen((open) => !open)}
          >
            {navOpen ? t('nav.closeMenu') : t('nav.openMenu')}
          </Button>
          <div className={styles.organization}>
            <span className={styles.organizationName}>
              {organization.data?.name ?? t('shell.organization')}
            </span>
            {organization.data ? (
              <span className={styles.organizationMeta}>
                {t('shell.timeZone', { timeZone: organization.data.timeZone })}
              </span>
            ) : null}
          </div>
          <UserMenu />
        </header>

        <main id={MAIN_ID} className={styles.main} tabIndex={-1}>
          {content}
        </main>

        <footer className={styles.footer}>
          <small>{t('common.poweredBy')}</small>
        </footer>
      </div>
    </div>
  );
}
