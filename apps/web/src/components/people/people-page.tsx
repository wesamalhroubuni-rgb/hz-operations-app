'use client';

import { ROLES, USER_SORT_FIELDS, type User, type UserFull } from '@ops/shared';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { Checkbox } from '@/components/ui/form-field';
import { PageHeader } from '@/components/ui/layout';
import { EmptyState } from '@/components/ui/states';
import { Badge } from '@/components/ui/status-badge';
import { useCaller } from '@/hooks/use-caller';
import { useDirectory } from '@/hooks/use-directory';
import { useListParams } from '@/hooks/use-list-params';
import { useOrgTime } from '@/hooks/use-organization';
import { t, type TranslationKey } from '@/i18n';
import { activeFilterCount } from '@/lib/list-params';
import { canInvite, editableUserFields, type OneTimeCode } from '@/lib/people';

import styles from '../manage/manage.module.css';
import { OneTimeCodeDialog } from './one-time-code-dialog';
import { UserDrawer } from './user-drawer';
import { UserFormDialog } from './user-form-dialog';
import { useUserList } from './use-people';

export const USER_FILTER_KEYS = ['search', 'role', 'siteId', 'teamId', 'includeArchived'] as const;

/** `/people`: users with filters; admins invite and manage, managers view. */
export function PeoplePage() {
  const caller = useCaller();
  const directory = useDirectory();
  const orgTime = useOrgTime();
  const list = useListParams(USER_FILTER_KEYS);
  const users = useUserList(list.apiQuery);
  const [openId, setOpenId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  // The activation code of a new invite: shown once, then dropped.
  const [code, setCode] = useState<OneTimeCode | null>(null);
  const [invitedId, setInvitedId] = useState<string | null>(null);
  const filters = list.state.filters;
  const setFilter = (key: string) => (value: string | null) =>
    list.change({ filters: { [key]: value } });

  const columns: ColumnDef<User>[] = [
    {
      id: 'displayName',
      header: t('people.columns.name'),
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpenId(row.original.id)}
          aria-label={t('people.viewLabel', { name: row.original.displayName })}
        >
          {row.original.displayName}
        </Button>
      ),
    },
    {
      id: 'roles',
      header: t('people.columns.roles'),
      cell: ({ row }) =>
        row.original.roles.length === 0 ? (
          <span className={styles.muted}>{t('roles.none')}</span>
        ) : (
          <div className={styles.row}>
            {row.original.roles.map((role) => (
              <Badge key={role} tone="primary" label={t(`roles.${role}` as TranslationKey)} />
            ))}
          </div>
        ),
    },
    {
      id: 'email',
      header: t('people.columns.email'),
      cell: ({ row }) => (row.original.profile === 'basic' ? '—' : (row.original.email ?? '—')),
    },
    {
      id: 'phone',
      header: t('people.columns.phone'),
      cell: ({ row }) => (row.original.profile === 'basic' ? '—' : (row.original.phone ?? '—')),
    },
    {
      id: 'status',
      header: t('people.columns.status'),
      cell: ({ row }) => {
        const user = row.original;
        if (user.profile !== 'full') return '—';
        if (user.archivedAt) return <Badge tone="muted" label={t('people.state.archived')} />;
        return user.activated ? (
          <Badge tone="success" label={t('people.state.active')} />
        ) : (
          <Badge tone="warning" label={t('people.state.notActivated')} />
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title={t('pages.people.title')}
        description={
          caller.capabilities.manageUsers ? t('people.descriptionAdmin') : t('people.description')
        }
        actions={
          canInvite(caller.capabilities) ? (
            <Button variant="primary" onClick={() => setInviting(true)}>
              {t('people.invite')}
            </Button>
          ) : null
        }
      />
      <FilterBar activeCount={activeFilterCount(list.state)} onClear={list.clearFilters}>
        <SearchFilter value={filters.search} onChange={setFilter('search')} />
        <SelectFilter
          label={t('people.role')}
          value={filters.role}
          options={ROLES.map((value) => ({ value, label: t(`roles.${value}` as TranslationKey) }))}
          onChange={setFilter('role')}
        />
        <SelectFilter
          label={t('filters.site')}
          value={filters.siteId}
          options={directory.options.sites}
          onChange={setFilter('siteId')}
        />
        <SelectFilter
          label={t('filters.team')}
          value={filters.teamId}
          options={directory.options.teams}
          onChange={setFilter('teamId')}
        />
        <Checkbox
          label={t('filters.includeArchived')}
          checked={filters.includeArchived === 'true'}
          onChange={(event) => setFilter('includeArchived')(event.target.checked ? 'true' : null)}
        />
      </FilterBar>
      <DataTable
        columns={columns}
        data={users.data?.items}
        getRowId={(user) => user.id}
        caption={t('people.caption')}
        list={list}
        total={users.data?.total}
        sortableFields={USER_SORT_FIELDS}
        loading={users.isLoading}
        fetching={users.isFetching}
        error={users.error}
        onRetry={() => void users.refetch()}
        empty={<EmptyState title={t('people.empty')} />}
      />
      {openId ? <UserDrawer userId={openId} onClose={() => setOpenId(null)} /> : null}
      {inviting ? (
        <UserFormDialog
          user={null}
          editable={editableUserFields(caller.capabilities, false)}
          onClose={() => setInviting(false)}
          onInvited={(user: UserFull, issued) => {
            setCode(issued);
            setInvitedId(user.id);
          }}
        />
      ) : null}
      {code ? (
        <OneTimeCodeDialog
          code={code}
          expires={orgTime.dateTime(code.expiresAt)}
          onClose={() => {
            // Drop the code, then open the new person so a role can be added.
            setCode(null);
            setOpenId(invitedId);
            setInvitedId(null);
          }}
        />
      ) : null}
    </>
  );
}
