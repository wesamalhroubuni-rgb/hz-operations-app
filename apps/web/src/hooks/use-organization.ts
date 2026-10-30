'use client';

import type { Organization } from '@ops/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';
import { createOrgTime, type OrgTime } from '@/lib/time';

/** `GET /organization`: `summary` for everyone, `full` (with settings) for admins. */
export function useOrganization() {
  return useQuery<Organization>({
    queryKey: queryKeys.organization,
    queryFn: async () => unwrap(await requireApiClient().organization.get()),
    staleTime: 5 * 60_000,
  });
}

/**
 * Time formatting in the organization's time zone. The app shell renders dashboard pages only
 * once `GET /organization` has loaded (`orgTimeGate`), so pages never see the Europe/Istanbul
 * fallback of `createOrgTime()`; outside the shell, check `orgTimeGate(useOrganization())` first.
 */
export function useOrgTime(): OrgTime {
  const { data } = useOrganization();
  const timeZone = data?.timeZone;
  return useMemo(() => createOrgTime(timeZone), [timeZone]);
}
