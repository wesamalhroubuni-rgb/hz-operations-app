import type { AuditEvent } from '@ops/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AuditEventDetail } from '@/components/audit/audit-page';
import { OneTimeCodeView } from '@/components/people/one-time-code-dialog';
import { UserActionButtons } from '@/components/people/user-drawer';
import { CustomFieldEditor } from '@/components/structure/custom-field-editor';
import { PlaceTree } from '@/components/structure/places-panel';
import { TaskBoard } from '@/components/tasks/task-board';
import { TaskActionButtons } from '@/components/tasks/task-detail-page';
import { t } from '@/i18n';
import { IDS, makeTask, makeUserFull } from '@/lib/__fixtures__/agent-c-fixtures';
import { editorFieldsFrom, editorReducer } from '@/lib/log-type-editor';
import { userActions } from '@/lib/people';
import { capabilitiesFor } from '@/lib/permissions';
import { flattenTree } from '@/lib/structure';
import { groupTasksByStatus, taskActions } from '@/lib/tasks';

// Server-rendered markup of the presentational parts of the agent C screens: what each role is
// offered, the board columns, the one-time code, the field editor and the audit diff.

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);
const noop = () => {};

describe('role-based rendering', () => {
  const user = makeUserFull({ activated: true });
  const contact = {
    profile: 'contact' as const,
    id: IDS.worker,
    displayName: 'A',
    roles: [],
    email: null,
    phone: null,
  };

  it('shows admins the people actions, managers and supervisors none', () => {
    const adminHtml = render(
      createElement(UserActionButtons, {
        actions: userActions(capabilitiesFor(['admin']), user, false),
        onAction: noop,
      }),
    );
    expect(adminHtml).toContain(t('people.actions.resetPassword'));
    expect(adminHtml).toContain(t('people.actions.archive'));
    expect(adminHtml).not.toContain(t('people.actions.activationCode'));
    for (const role of ['manager', 'supervisor']) {
      const html = render(
        createElement(UserActionButtons, {
          actions: userActions(capabilitiesFor([role]), contact, false),
          onAction: noop,
        }),
      );
      expect(html).not.toContain('<button');
    }
  });

  it('lets a manager edit only their own profile', () => {
    const html = render(
      createElement(UserActionButtons, {
        actions: userActions(capabilitiesFor(['manager']), { ...user, id: IDS.me }, true),
        onAction: noop,
      }),
    );
    expect(html).toContain(t('people.actions.edit'));
    expect(html).not.toContain(t('people.actions.resetPassword'));
  });

  it('shows the task actions to supervisors, managers and admins, not to workers', () => {
    for (const role of ['supervisor', 'manager', 'admin']) {
      const html = render(
        createElement(TaskActionButtons, {
          actions: taskActions(capabilitiesFor([role]), makeTask()),
          onAction: noop,
        }),
      );
      expect(html).toContain(t('tasks.status.change'));
      expect(html).toContain(t('tasks.cancel.action'));
      expect(html).toContain(t('tasks.reassign'));
    }
    const worker = render(
      createElement(TaskActionButtons, {
        actions: taskActions(capabilitiesFor(['worker']), makeTask()),
        onAction: noop,
      }),
    );
    expect(worker).toBe('');
  });

  it('shows structure edit buttons only when the caller may manage', () => {
    const rows = flattenTree([
      { ...siteRow('a', 'Alpha', null) },
      { ...siteRow('b', 'Beta', 'a') },
    ]);
    const props = { kind: 'sites' as const, rows, onEdit: noop, onArchive: noop, onRestore: noop };
    const manager = render(createElement(PlaceTree, { ...props, canManage: true }));
    expect(manager).toContain(t('structure.place.edit', { name: 'Alpha' }));
    expect(manager).toContain('data-depth="1"');
    const viewer = render(createElement(PlaceTree, { ...props, canManage: false }));
    expect(viewer).not.toContain('<button');
  });
});

function siteRow(id: string, name: string, parentId: string | null) {
  return {
    id,
    organizationId: IDS.org,
    parentId,
    name,
    code: null,
    description: null,
    address: null,
    latitude: null,
    longitude: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    archivedAt: null,
  };
}

describe('task board', () => {
  it('renders one labelled column per status with the tasks grouped, and the blocked reason', () => {
    const groups = groupTasksByStatus([
      makeTask({ id: 'a', title: 'Gate', status: 'blocked', statusReason: 'No parts' }),
      makeTask({ id: 'b', title: 'Wall', status: 'done' }),
    ]);
    const html = render(
      createElement(TaskBoard, {
        groups,
        info: () => ({ assignees: 'Nobody', place: '', due: 'No due date', overdue: false }),
        canChangeStatus: () => true,
        onChangeStatus: noop,
      }),
    );
    const order = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'].map((status) =>
      html.indexOf(`data-status="${status}"`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const blockedColumn = html.slice(order[2], order[3]);
    expect(blockedColumn).toContain('data-task-id="a"');
    expect(blockedColumn).toContain(t('tasks.blockedReason', { reason: 'No parts' }));
    expect(html.slice(order[3], order[4])).toContain('data-task-id="b"');
  });
});

describe('one-time code', () => {
  const code = {
    purpose: 'activation' as const,
    code: 'TEST-CODE-0000',
    link: null,
    expiresAt: '2026-10-29T08:00:00.000Z',
    userName: 'Ayşe',
  };

  it('shows the code with a copy button and the once-only warning', () => {
    const html = render(createElement(OneTimeCodeView, { code, expires: '29 Oct' }));
    expect(html).toContain('TEST-CODE-0000');
    expect(html).toContain(t('people.code.copy'));
    expect(html).toContain(t('people.code.warning'));
  });

  it('explains when the environment does not show codes', () => {
    const html = render(
      createElement(OneTimeCodeView, { code: { ...code, code: null }, expires: '29 Oct' }),
    );
    expect(html).toContain(t('people.code.notShown'));
    expect(html).not.toContain(t('people.code.copy'));
  });
});

describe('custom-field editor', () => {
  it('locks the key of saved fields and edits it on new ones, with reorder buttons', () => {
    const fields = editorReducer(
      editorFieldsFrom([{ key: 'depth_cm', label: 'Depth', type: 'number', required: true }]),
      { type: 'add', uid: 'n1' },
    );
    const html = render(
      createElement(CustomFieldEditor, { fields, errors: {}, dispatch: noop, newUid: () => 'x' }),
    );
    const saved = html.slice(
      html.indexOf('data-field-key="depth_cm"'),
      html.indexOf('data-field-key="field"'),
    );
    expect(saved).toMatch(/value="depth_cm"[^>]*readOnly|readOnly[^>]*value="depth_cm"/i);
    expect(saved).toContain(t('structure.fields.keyLocked'));
    const added = html.slice(html.indexOf('data-field-key="field"'));
    expect(added).not.toMatch(/readOnly/i);
    expect(html).toContain(t('structure.fields.moveUp', { name: 'Depth' }));
    expect(html).toContain(t('structure.fields.required'));
  });
});

describe('audit event detail', () => {
  it('shows the diff with hidden values marked and the offline-sync metadata', () => {
    const event: AuditEvent = {
      id: '0190f3a2-7c1e-7000-8000-000000000900',
      organizationId: IDS.org,
      actorType: 'user',
      actorId: IDS.me,
      action: 'work_log.updated',
      entityType: 'work_log',
      entityId: '0190f3a2-7c1e-7000-8000-000000000901',
      before: null,
      after: { passwordHash: '[redacted]' },
      changes: { secret_note: { from: '[redacted]', to: '[redacted]' } },
      correlationId: 'req-1',
      metadata: {
        via: 'offline_sync',
        deviceTime: null,
        serverTime: '2026-10-28T10:00:00.000Z',
        clockSkewSeconds: null,
      },
      occurredAt: '2026-10-28T10:00:00.000Z',
    };
    const html = render(
      createElement(AuditEventDetail, { event, actorName: 'Aylin', formatTime: (v: string) => v }),
    );
    expect(html).toContain(t('audit.detail.redacted'));
    expect(html).toContain(t('audit.detail.offlineTitle'));
    expect(html).toContain('Aylin');
  });
});
