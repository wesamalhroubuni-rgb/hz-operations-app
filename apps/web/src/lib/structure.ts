import {
  createSiteSchema,
  createTeamSchema,
  MAX_PAGE_SIZE,
  updateSiteSchema,
  updateTeamSchema,
  type CreateSite,
  type CreateTeam,
  type Paginated,
  type Site,
  type Team,
  type UpdateSite,
  type UpdateTeam,
} from '@ops/shared';

/**
 * Structure screen logic (Phase 6, agent C): the site and team trees, which parents a place may
 * move under, and the create / update bodies. Pure, so tested. Managers and admins manage
 * structure (ADR-0005); the API decides.
 */

// ---- Trees ------------------------------------------------------------------------------

export interface TreeItem {
  id: string;
  parentId: string | null;
  name: string;
}

export interface TreeRow<Item extends TreeItem> {
  item: Item;
  depth: number;
  /** Ids from the root down to the parent. */
  path: string[];
  hasChildren: boolean;
}

/**
 * The places as a depth-first list (parents before their children, siblings by name), ready to
 * render indented. A place whose parent is not in the list (archived and hidden, or outside the
 * caller's view) is shown as a root. A cycle in bad data cannot loop: each place appears once.
 */
export function flattenTree<Item extends TreeItem>(items: readonly Item[]): TreeRow<Item>[] {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string | null, Item[]>();
  for (const item of items) {
    const parent = item.parentId !== null && ids.has(item.parentId) ? item.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const rows: TreeRow<Item>[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number, path: string[]) => {
    for (const item of children.get(parent) ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push({ item, depth, path, hasChildren: (children.get(item.id)?.length ?? 0) > 0 });
      visit(item.id, depth + 1, [...path, item.id]);
    }
  };
  visit(null, 0, []);
  // Anything left is part of a cycle: list it at the root rather than lose it.
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      rows.push({ item, depth: 0, path: [], hasChildren: false });
    }
  }
  return rows;
}

/** The place and everything below it. */
export function descendantIds(items: readonly TreeItem[], id: string): Set<string> {
  const result = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (item.parentId !== null && result.has(item.parentId) && !result.has(item.id)) {
        result.add(item.id);
        grew = true;
      }
    }
  }
  return result;
}

/**
 * Parents a place may have: any active place except itself and its descendants (that would
 * make a loop). Indented labels show the hierarchy in a native select.
 */
export function parentOptions<Item extends TreeItem & { archivedAt: string | null }>(
  items: readonly Item[],
  editingId: string | null,
): { value: string; label: string }[] {
  const excluded = editingId === null ? new Set<string>() : descendantIds(items, editingId);
  return flattenTree(items.filter((item) => item.archivedAt === null))
    .filter((row) => !excluded.has(row.item.id))
    .map((row) => ({ value: row.item.id, label: `${'— '.repeat(row.depth)}${row.item.name}` }));
}

/** Reads every page of a list endpoint (structure lists are small; capped for safety). */
export async function fetchAllPages<Item>(
  fetchPage: (page: number, pageSize: number) => Promise<Paginated<Item>>,
  maxPages = 20,
): Promise<{ items: Item[]; total: number; complete: boolean }> {
  const items: Item[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage(page, MAX_PAGE_SIZE);
    items.push(...result.items);
    total = result.total;
    if (items.length >= result.total || result.items.length === 0) {
      return { items, total, complete: true };
    }
  }
  return { items, total, complete: items.length >= total };
}

// ---- Forms ------------------------------------------------------------------------------

export type FormErrors = Record<string, string>;
export type BodyResult<Body> = { ok: true; body: Body } | { ok: false; errors: FormErrors };

function issuesToErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FormErrors {
  const errors: FormErrors = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : 'form';
    errors[key] ??= issue.message;
  }
  return errors;
}

export interface SiteFormState {
  name: string;
  code: string;
  description: string;
  address: string;
  latitude: string;
  longitude: string;
  parentId: string;
}

export interface TeamFormState {
  name: string;
  description: string;
  parentId: string;
}

export function siteFormFrom(site: Site | null): SiteFormState {
  return {
    name: site?.name ?? '',
    code: site?.code ?? '',
    description: site?.description ?? '',
    address: site?.address ?? '',
    latitude: site?.latitude === null || site?.latitude === undefined ? '' : String(site.latitude),
    longitude:
      site?.longitude === null || site?.longitude === undefined ? '' : String(site.longitude),
    parentId: site?.parentId ?? '',
  };
}

export function teamFormFrom(team: Team | null): TeamFormState {
  return {
    name: team?.name ?? '',
    description: team?.description ?? '',
    parentId: team?.parentId ?? '',
  };
}

const text = (value: string) => (value.trim() === '' ? null : value.trim());

function coordinate(value: string): number | null | 'invalid' {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}

function siteValues(form: SiteFormState, invalidNumber: string) {
  const latitude = coordinate(form.latitude);
  const longitude = coordinate(form.longitude);
  const errors: FormErrors = {};
  if (latitude === 'invalid') errors.latitude = invalidNumber;
  if (longitude === 'invalid') errors.longitude = invalidNumber;
  return {
    errors,
    values: {
      name: form.name.trim(),
      code: text(form.code),
      description: text(form.description),
      address: text(form.address),
      latitude: latitude === 'invalid' ? null : latitude,
      longitude: longitude === 'invalid' ? null : longitude,
      parentId: form.parentId === '' ? null : form.parentId,
    },
  };
}

/** `POST /sites`. */
export function createSiteBody(form: SiteFormState, invalidNumber: string): BodyResult<CreateSite> {
  const { errors, values } = siteValues(form, invalidNumber);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const parsed = createSiteSchema.safeParse(values);
  return parsed.success
    ? { ok: true, body: values }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

/** `PATCH /sites/:id` with only the changed fields; null when nothing changed. */
export function updateSiteBody(
  site: Site,
  form: SiteFormState,
  invalidNumber: string,
): BodyResult<UpdateSite | null> {
  const { errors, values } = siteValues(form, invalidNumber);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const body: UpdateSite = {};
  if (values.name !== site.name) body.name = values.name;
  if (values.code !== site.code) body.code = values.code;
  if (values.description !== site.description) body.description = values.description;
  if (values.address !== site.address) body.address = values.address;
  if (values.latitude !== site.latitude) body.latitude = values.latitude;
  if (values.longitude !== site.longitude) body.longitude = values.longitude;
  if (values.parentId !== site.parentId) body.parentId = values.parentId;
  if (Object.keys(body).length === 0) return { ok: true, body: null };
  const parsed = updateSiteSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

/** `POST /teams`. */
export function createTeamBody(form: TeamFormState): BodyResult<CreateTeam> {
  const body: CreateTeam = {
    name: form.name.trim(),
    description: text(form.description),
    parentId: form.parentId === '' ? null : form.parentId,
  };
  const parsed = createTeamSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

/** `PATCH /teams/:id` with only the changed fields; null when nothing changed. */
export function updateTeamBody(team: Team, form: TeamFormState): BodyResult<UpdateTeam | null> {
  const body: UpdateTeam = {};
  const name = form.name.trim();
  if (name !== team.name) body.name = name;
  const description = text(form.description);
  if (description !== team.description) body.description = description;
  const parentId = form.parentId === '' ? null : form.parentId;
  if (parentId !== team.parentId) body.parentId = parentId;
  if (Object.keys(body).length === 0) return { ok: true, body: null };
  const parsed = updateTeamSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}
