'use client';

import { WORK_LOG_STATUSES } from '@ops/shared';

import { DateRangePicker, FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { Checkbox } from '@/components/ui/form-field';
import type { ListParams } from '@/hooks/use-list-params';
import { t } from '@/i18n';
import type { DirectoryIndex, DirectoryOption } from '@/lib/directory';
import { activeFilterCount } from '@/lib/list-params';
import type { OrgTime } from '@/lib/time';
import { dayRangeFilters, dayRangeOf } from '@/lib/work-logs/filters';

function options(items: readonly DirectoryOption[]) {
  return items.map((item) => ({
    value: item.value,
    label: item.archived ? `${item.label} (${t('status.archived')})` : item.label,
  }));
}

/**
 * The work-log filters (site, team, worker, log type, status, date range, photos, search),
 * written to the URL through `useListParams`. Days are the organization's days (`orgTime`).
 * Used by the list and the map; search, photos and archived can be turned off.
 */
export function WorkLogFilters({
  list,
  names,
  orgTime,
  withSearch = true,
  withPhotos = true,
  withArchived = true,
}: Readonly<{
  list: ListParams;
  names: DirectoryIndex;
  orgTime: OrgTime;
  withSearch?: boolean;
  withPhotos?: boolean;
  withArchived?: boolean;
}>) {
  const { filters } = list.state;
  const set = (key: string) => (value: string | null) => list.change({ filters: { [key]: value } });

  return (
    <FilterBar activeCount={activeFilterCount(list.state)} onClear={list.clearFilters}>
      {withSearch ? (
        <SearchFilter
          value={filters.search}
          onChange={set('search')}
          placeholder={t('workLogs.filters.searchPlaceholder')}
        />
      ) : null}
      <SelectFilter
        label={t('filters.site')}
        value={filters.siteId}
        options={options(names.options.sites)}
        onChange={set('siteId')}
      />
      <SelectFilter
        label={t('filters.team')}
        value={filters.teamId}
        options={options(names.options.teams)}
        onChange={set('teamId')}
      />
      <SelectFilter
        label={t('filters.worker')}
        value={filters.authorId}
        options={options(names.options.users)}
        onChange={set('authorId')}
      />
      <SelectFilter
        label={t('filters.logType')}
        value={filters.logTypeId}
        options={options(names.options.logTypes)}
        onChange={set('logTypeId')}
      />
      <SelectFilter
        label={t('filters.status')}
        value={filters.status}
        options={WORK_LOG_STATUSES.map((status) => ({
          value: status,
          label: t(`status.workLog.${status}`),
        }))}
        onChange={set('status')}
      />
      {withPhotos ? (
        <SelectFilter
          label={t('filters.hasPhotos')}
          value={filters.hasPhotos}
          options={[
            { value: 'true', label: t('filters.withPhotos') },
            { value: 'false', label: t('filters.withoutPhotos') },
          ]}
          onChange={set('hasPhotos')}
        />
      ) : null}
      <DateRangePicker
        value={dayRangeOf(filters, orgTime.timeZone)}
        today={orgTime.today()}
        onChange={(range) => {
          const next = dayRangeFilters(range, orgTime);
          if (next !== null) {
            list.change({ filters: next });
          }
        }}
      />
      {withArchived ? (
        <Checkbox
          label={t('filters.includeArchived')}
          checked={filters.includeArchived === 'true'}
          onChange={(event) =>
            list.change({ filters: { includeArchived: event.target.checked ? 'true' : null } })
          }
        />
      ) : null}
    </FilterBar>
  );
}
