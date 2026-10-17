import { useMemo } from 'react';

import { useLogTypes, useSites, useTeams } from '../data/queries';

/** Names of log types, sites and teams by id, for lists and details. */
export function useLookups() {
  const logTypes = useLogTypes();
  const sites = useSites();
  const teams = useTeams();
  return useMemo(() => {
    const logTypeById = new Map((logTypes.data ?? []).map((type) => [type.id, type]));
    const siteName = new Map((sites.data ?? []).map((site) => [site.id, site.name]));
    const teamName = new Map((teams.data ?? []).map((team) => [team.id, team.name]));
    return {
      logType: (id: string | null) => (id === null ? null : (logTypeById.get(id) ?? null)),
      logTypeName: (id: string | null) =>
        id === null ? null : (logTypeById.get(id)?.name ?? null),
      siteName: (id: string | null) => (id === null ? null : (siteName.get(id) ?? null)),
      teamName: (id: string | null) => (id === null ? null : (teamName.get(id) ?? null)),
    };
  }, [logTypes.data, sites.data, teams.data]);
}
