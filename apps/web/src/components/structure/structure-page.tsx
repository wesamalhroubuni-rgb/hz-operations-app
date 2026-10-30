'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef, type KeyboardEvent } from 'react';

import { PageHeader } from '@/components/ui/layout';
import { useCaller } from '@/hooks/use-caller';
import { t } from '@/i18n';

import styles from '../manage/manage.module.css';
import { LogTypesPanel } from './log-types-panel';
import { PlacesPanel } from './places-panel';

const TABS = ['sites', 'teams', 'logTypes'] as const;
type Tab = (typeof TABS)[number];

/** `/structure`: sites, teams (with parent/child) and log types; tab in the URL (`?tab=`). */
export function StructurePage() {
  const caller = useCaller();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requested = searchParams.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as Tab)
    : 'sites';
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const canManage = caller.capabilities.manageStructure;

  function select(next: Tab, focus = false) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'sites') params.delete('tab');
    else params.set('tab', next);
    const query = params.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
    if (focus) refs.current[next]?.focus();
  }

  // Arrow keys move between tabs (WAI-ARIA tabs pattern); Home / End jump to the ends.
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = TABS.indexOf(tab);
    const rtl = document.documentElement.dir === 'rtl';
    let next: number | null = null;
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (index + 1) % TABS.length;
    else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft'))
      next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next !== null) {
      event.preventDefault();
      select(TABS[next] as Tab, true);
    }
  }

  return (
    <>
      <PageHeader
        title={t('pages.structure.title')}
        description={canManage ? t('structure.description') : t('structure.readOnly')}
      />
      <div className={styles.tabs} role="tablist" aria-label={t('structure.tabs.label')}>
        {TABS.map((value) => (
          <button
            key={value}
            ref={(element) => {
              refs.current[value] = element;
            }}
            id={`tab-${value}`}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => select(value)}
            onKeyDown={onKeyDown}
          >
            {t(`structure.tabs.${value}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'logTypes' ? (
          <LogTypesPanel canManage={canManage} />
        ) : (
          <PlacesPanel key={tab} kind={tab} canManage={canManage} />
        )}
      </div>
    </>
  );
}
