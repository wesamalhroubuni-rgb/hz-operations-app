import type { Directory, DirectoryLogType, DirectoryPlace, DirectoryUser } from '@ops/shared';

export interface DirectoryOption {
  value: string;
  label: string;
  archived: boolean;
}

/** Look-ups over `GET /directory`. Pure, so tested. */
export interface DirectoryIndex {
  user(id: string | null | undefined): string;
  site(id: string | null | undefined): string;
  team(id: string | null | undefined): string;
  logType(id: string | null | undefined): string;
  users: DirectoryUser[];
  sites: DirectoryPlace[];
  teams: DirectoryPlace[];
  logTypes: DirectoryLogType[];
  /** Picker options, sorted by label, archived ones last. */
  options: {
    users: DirectoryOption[];
    workers: DirectoryOption[];
    sites: DirectoryOption[];
    teams: DirectoryOption[];
    logTypes: DirectoryOption[];
  };
  truncated: boolean;
}

function toOptions(items: { id: string; label: string; archived: boolean }[]): DirectoryOption[] {
  return items
    .map((item) => ({ value: item.id, label: item.label, archived: item.archived }))
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) || a.label.localeCompare(b.label, undefined, {}),
    );
}

export function createDirectoryIndex(
  directory: Directory | undefined,
  unknownLabel: string,
): DirectoryIndex {
  const users = directory?.users ?? [];
  const sites = directory?.sites ?? [];
  const teams = directory?.teams ?? [];
  const logTypes = directory?.logTypes ?? [];
  const byId = <Item extends { id: string }>(items: Item[], label: (item: Item) => string) => {
    const map = new Map(items.map((item) => [item.id, label(item)]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? unknownLabel) : '');
  };
  return {
    user: byId(users, (user) => user.displayName),
    site: byId(sites, (site) => site.name),
    team: byId(teams, (team) => team.name),
    logType: byId(logTypes, (logType) => logType.name),
    users,
    sites,
    teams,
    logTypes,
    options: {
      users: toOptions(
        users.map((u) => ({ id: u.id, label: u.displayName, archived: u.archived })),
      ),
      workers: toOptions(
        users
          .filter((u) => u.roles.includes('worker'))
          .map((u) => ({ id: u.id, label: u.displayName, archived: u.archived })),
      ),
      sites: toOptions(sites.map((s) => ({ id: s.id, label: s.name, archived: s.archived }))),
      teams: toOptions(teams.map((s) => ({ id: s.id, label: s.name, archived: s.archived }))),
      logTypes: toOptions(logTypes.map((l) => ({ id: l.id, label: l.name, archived: l.archived }))),
    },
    truncated: directory?.truncated ?? false,
  };
}
