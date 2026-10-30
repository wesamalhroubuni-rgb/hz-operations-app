'use client';

import type { Site, Team } from '@ops/shared';
import { useState, type FormEvent } from 'react';

import { FormAlert, Notice } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Modal } from '@/components/ui/dialog';
import { Checkbox, FormField, Input, Select, Textarea } from '@/components/ui/form-field';
import { Toolbar } from '@/components/ui/layout';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { t } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import {
  createSiteBody,
  createTeamBody,
  flattenTree,
  parentOptions,
  siteFormFrom,
  teamFormFrom,
  updateSiteBody,
  updateTeamBody,
  type FormErrors,
  type SiteFormState,
  type TeamFormState,
  type TreeRow,
} from '@/lib/structure';

import styles from '../manage/manage.module.css';
import { useAllSites, useAllTeams, useStructureChanged } from './use-structure';

type Kind = 'sites' | 'teams';
type Place = Site | Team;

const INDENT = [undefined, styles.indent1, styles.indent2, styles.indent3, styles.indent4];

/**
 * The place tree as a table (props only, so it renders in tests): indented names, parent,
 * archived state, and edit / archive / restore when the caller may manage structure.
 */
export function PlaceTree<Item extends Place>({
  kind,
  rows,
  canManage,
  onEdit,
  onArchive,
  onRestore,
}: Readonly<{
  kind: Kind;
  rows: TreeRow<Item>[];
  canManage: boolean;
  onEdit: (item: Item) => void;
  onArchive: (item: Item) => void;
  onRestore: (item: Item) => void;
}>) {
  return (
    <table className={styles.diff}>
      <caption className={styles.legend}>{t(`structure.${kind}.caption`)}</caption>
      <thead>
        <tr>
          <th scope="col">{t(`structure.${kind}.name`)}</th>
          {kind === 'sites' ? <th scope="col">{t('structure.sites.code')}</th> : null}
          <th scope="col">{t('structure.sites.description')}</th>
          {canManage ? <th scope="col">{t('tasks.columns.actions')}</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const item = row.item;
          return (
            <tr key={item.id} data-depth={row.depth}>
              <td className={INDENT[Math.min(row.depth, 4)]}>
                <span className={styles.treeName}>
                  {row.depth > 0 ? <span aria-hidden="true">└</span> : null}
                  <strong>{item.name}</strong>
                  {item.archivedAt ? <StatusBadge kind="archived" /> : null}
                </span>
              </td>
              {kind === 'sites' ? <td>{(item as Site).code ?? '—'}</td> : null}
              <td>{item.description ?? '—'}</td>
              {canManage ? (
                <td>
                  <div className={styles.row}>
                    {item.archivedAt === null ? (
                      <>
                        <Button
                          size="sm"
                          onClick={() => onEdit(item)}
                          aria-label={t('structure.place.edit', { name: item.name })}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onArchive(item)}
                          aria-label={t('structure.place.archive', { name: item.name })}
                        >
                          {t('common.archive')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => onRestore(item)}
                        aria-label={t('structure.place.restore', { name: item.name })}
                      >
                        {t('common.restore')}
                      </Button>
                    )}
                  </div>
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Sites or teams: the tree, create / edit, archive / restore. */
export function PlacesPanel({ kind, canManage }: Readonly<{ kind: Kind; canManage: boolean }>) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const sites = useAllSites(includeArchived);
  const teams = useAllTeams(includeArchived);
  const query = kind === 'sites' ? sites : teams;
  const changed = useStructureChanged();
  const [editing, setEditing] = useState<Place | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Place | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const items: Place[] = query.data?.items ?? [];
  const rows = flattenTree(items);

  async function archive() {
    if (!archiving) return;
    setBusy(true);
    setError(null);
    try {
      const api = requireApiClient();
      unwrap(
        kind === 'sites'
          ? await api.sites.archive(archiving.id)
          : await api.teams.archive(archiving.id),
      );
      await changed(kind);
      setNotice(t('structure.place.archived'));
      setArchiving(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function restore(item: Place) {
    setError(null);
    try {
      const api = requireApiClient();
      unwrap(
        kind === 'sites' ? await api.sites.restore(item.id) : await api.teams.restore(item.id),
      );
      await changed(kind);
      setNotice(t('structure.place.restored'));
    } catch (failure) {
      setError(failure);
    }
  }

  return (
    <div className={styles.stack}>
      <Toolbar
        start={
          <Checkbox
            label={t('structure.showArchived')}
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
        }
        end={
          canManage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              {t(`structure.${kind}.create`)}
            </Button>
          ) : null
        }
      />
      <Notice>{notice}</Notice>
      {error && archiving === null ? <FormAlert error={error} /> : null}
      {query.data && !query.data.complete ? (
        <p className={styles.muted}>
          {t('structure.partial', { shown: query.data.items.length, total: query.data.total })}
        </p>
      ) : null}
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t(`structure.${kind}.empty`)} />
      ) : (
        <PlaceTree
          kind={kind}
          rows={rows}
          canManage={canManage}
          onEdit={setEditing}
          onArchive={(item) => {
            setError(null);
            setArchiving(item);
          }}
          onRestore={(item) => void restore(item)}
        />
      )}
      {editing ? (
        <PlaceDialog
          kind={kind}
          place={editing === 'new' ? null : editing}
          all={items}
          onClose={() => setEditing(null)}
          onSaved={() => setNotice(t(`structure.${kind}.saved`))}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        title={t('structure.place.archiveTitle', { name: archiving?.name ?? '' })}
        description={t('structure.place.archiveDescription')}
        confirmLabel={t('common.archive')}
        tone="danger"
        busy={busy}
        onConfirm={() => void archive()}
        onCancel={() => {
          setArchiving(null);
          setError(null);
        }}
      >
        {error ? <FormAlert error={error} /> : null}
      </ConfirmDialog>
    </div>
  );
}

function PlaceDialog({
  kind,
  place,
  all,
  onClose,
  onSaved,
}: Readonly<{
  kind: Kind;
  place: Place | null;
  all: Place[];
  onClose: () => void;
  onSaved: () => void;
}>) {
  const changed = useStructureChanged();
  const [site, setSite] = useState<SiteFormState>(() =>
    siteFormFrom(kind === 'sites' ? (place as Site | null) : null),
  );
  const [team, setTeam] = useState<TeamFormState>(() =>
    teamFormFrom(kind === 'teams' ? (place as Team | null) : null),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const invalidNumber = t('structure.place.invalidNumber');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setFailure(null);
    const api = requireApiClient();
    let send: () => Promise<unknown>;
    if (kind === 'sites' && place) {
      const built = updateSiteBody(place as Site, site, invalidNumber);
      if (!built.ok) return setErrors(built.errors);
      const body = built.body;
      if (body === null) return onClose();
      send = async () => unwrap(await api.sites.update(place.id, body));
    } else if (kind === 'sites') {
      const built = createSiteBody(site, invalidNumber);
      if (!built.ok) return setErrors(built.errors);
      send = async () => unwrap(await api.sites.create(built.body));
    } else if (place) {
      const built = updateTeamBody(place as Team, team);
      if (!built.ok) return setErrors(built.errors);
      const body = built.body;
      if (body === null) return onClose();
      send = async () => unwrap(await api.teams.update(place.id, body));
    } else {
      const built = createTeamBody(team);
      if (!built.ok) return setErrors(built.errors);
      send = async () => unwrap(await api.teams.create(built.body));
    }
    setBusy(true);
    try {
      await send();
      await changed(kind);
      onSaved();
      onClose();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  const parents = parentOptions(all, place?.id ?? null);
  const formId = 'place-form';
  const text = <F extends string>(
    label: string,
    value: string,
    onChange: (value: string) => void,
    error: string | undefined,
    options: { required?: boolean; hint?: string; multiline?: boolean; field?: F } = {},
  ) => (
    <FormField label={label} required={options.required} hint={options.hint} error={error}>
      {(control) =>
        options.multiline ? (
          <Textarea {...control} value={value} onChange={(event) => onChange(event.target.value)} />
        ) : (
          <Input {...control} value={value} onChange={(event) => onChange(event.target.value)} />
        )
      }
    </FormField>
  );

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={place ? t(`structure.${kind}.editTitle`) : t(`structure.${kind}.createTitle`)}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            busy={busy}
            busyLabel={t('common.saving')}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.formStack} onSubmit={submit} noValidate>
        {kind === 'sites' ? (
          <>
            {text(
              t('structure.sites.name'),
              site.name,
              (name) => setSite({ ...site, name }),
              errors.name,
              { required: true },
            )}
            {text(
              t('structure.sites.code'),
              site.code,
              (code) => setSite({ ...site, code }),
              errors.code,
              {
                hint: t('structure.sites.codeHint'),
              },
            )}
            {text(
              t('structure.sites.description'),
              site.description,
              (description) => setSite({ ...site, description }),
              errors.description,
              {
                multiline: true,
              },
            )}
            {text(
              t('structure.sites.address'),
              site.address,
              (address) => setSite({ ...site, address }),
              errors.address,
            )}
            <div className={styles.formGrid}>
              {text(
                t('structure.sites.latitude'),
                site.latitude,
                (latitude) => setSite({ ...site, latitude }),
                errors.latitude,
              )}
              {text(
                t('structure.sites.longitude'),
                site.longitude,
                (longitude) => setSite({ ...site, longitude }),
                errors.longitude,
              )}
            </div>
          </>
        ) : (
          <>
            {text(
              t('structure.teams.name'),
              team.name,
              (name) => setTeam({ ...team, name }),
              errors.name,
              { required: true },
            )}
            {text(
              t('structure.teams.description'),
              team.description,
              (description) => setTeam({ ...team, description }),
              errors.description,
              {
                multiline: true,
              },
            )}
          </>
        )}
        <FormField label={t(`structure.${kind}.parent`)} error={errors.parentId}>
          {(control) => (
            <Select
              {...control}
              value={kind === 'sites' ? site.parentId : team.parentId}
              placeholder={t(`structure.${kind}.noParent`)}
              options={parents}
              onChange={(event) =>
                kind === 'sites'
                  ? setSite({ ...site, parentId: event.target.value })
                  : setTeam({ ...team, parentId: event.target.value })
              }
            />
          )}
        </FormField>
        {failure ? <FormAlert error={failure} /> : null}
      </form>
    </Modal>
  );
}
