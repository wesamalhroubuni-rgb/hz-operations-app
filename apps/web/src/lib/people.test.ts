import type { CreatedUser, IssuedCode } from '@ops/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IDS, makeUserFull, ok } from './__fixtures__/agent-c-fixtures';
import {
  createMembershipBody,
  editableUserFields,
  emptyUserForm,
  inviteUser,
  issueUserCode,
  membershipBody,
  splitCreatedUser,
  updateUserBody,
  userActions,
  userFormFrom,
} from './people';
import { capabilitiesFor } from './permissions';

const admin = capabilitiesFor(['admin']);
const manager = capabilitiesFor(['manager']);
const supervisor = capabilitiesFor(['supervisor']);

// A fixed fake code: not a real credential, never printed.
const ISSUED: IssuedCode = {
  purpose: 'activation',
  expiresAt: '2026-10-29T08:00:00.000Z',
  code: 'TEST-CODE-0000',
  link: 'http://localhost/activate?code=TEST-CODE-0000',
};

function storageSpy() {
  return {
    setItem: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0,
  };
}

describe('user actions by role', () => {
  it('admins manage; managers and supervisors only view others', () => {
    const user = makeUserFull({ activated: false });
    expect(userActions(admin, user, false)).toEqual({
      invite: true,
      edit: true,
      issueActivationCode: true,
      resetPassword: false,
      archive: true,
      restore: false,
      sessions: true,
      memberships: true,
    });
    const contact = {
      profile: 'contact' as const,
      id: IDS.worker,
      displayName: 'A',
      roles: [],
      email: null,
      phone: null,
    };
    expect(Object.values(userActions(manager, contact, false))).not.toContain(true);
    expect(Object.values(userActions(supervisor, contact, false))).not.toContain(true);
  });

  it('offers reset for activated users, restore for archived ones, never archiving oneself', () => {
    expect(userActions(admin, makeUserFull({ activated: true }), false).resetPassword).toBe(true);
    const archived = userActions(
      admin,
      makeUserFull({ archivedAt: '2026-10-02T00:00:00Z' }),
      false,
    );
    expect(archived).toMatchObject({
      restore: true,
      archive: false,
      edit: false,
      resetPassword: false,
    });
    expect(userActions(admin, makeUserFull({ id: IDS.me }), true).archive).toBe(false);
  });

  it('lets anyone edit only their own name and language', () => {
    expect(editableUserFields(manager, true)).toEqual(['displayName', 'locale']);
    expect(editableUserFields(manager, false)).toEqual([]);
    expect(editableUserFields(admin, false)).toHaveLength(5);
  });
});

describe('activation and reset codes are shown once and never kept', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('splits the created user from its code (the cached user has no activation key)', () => {
    const created: CreatedUser = { ...makeUserFull({ activated: false }), activation: ISSUED };
    const { user, code } = splitCreatedUser(created);
    expect('activation' in user).toBe(false);
    expect(JSON.stringify(user)).not.toContain(ISSUED.code);
    expect(code).toEqual({ ...ISSUED, userName: 'Ayşe Worker' });
  });

  it('invites without touching browser storage', async () => {
    const local = storageSpy();
    const session = storageSpy();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    const api = {
      create: vi.fn(async () =>
        ok<CreatedUser>({ ...makeUserFull({ activated: false }), activation: ISSUED }),
      ),
      issueActivationCode: vi.fn(),
      issuePasswordReset: vi.fn(),
    };
    const outcome = await inviteUser(api, {
      ...emptyUserForm(),
      displayName: 'Ayşe',
      email: 'AYSE@example.test',
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done') {
      expect(outcome.code.code).toBe(ISSUED.code);
      expect(outcome.user && 'activation' in outcome.user).toBe(false);
    }
    expect(api.create).toHaveBeenCalledWith({
      displayName: 'Ayşe',
      locale: 'en',
      email: 'AYSE@example.test',
    });
    for (const spy of [local, session]) {
      expect(spy.setItem).not.toHaveBeenCalled();
    }
  });

  it('issues a reset code for the right user and keeps a null code (non-development) as null', async () => {
    const api = {
      create: vi.fn(),
      issueActivationCode: vi.fn(),
      issuePasswordReset: vi.fn(async () =>
        ok<IssuedCode>({ ...ISSUED, purpose: 'password_reset', code: null, link: null }),
      ),
    };
    const outcome = await issueUserCode(
      api,
      { id: IDS.worker, displayName: 'Ayşe' },
      'password_reset',
    );
    expect(api.issuePasswordReset).toHaveBeenCalledWith(IDS.worker);
    expect(api.issueActivationCode).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'done',
      code: { purpose: 'password_reset', code: null },
    });
  });

  it('refuses an invite without any login identifier before calling the API', async () => {
    const api = { create: vi.fn(), issueActivationCode: vi.fn(), issuePasswordReset: vi.fn() };
    expect((await inviteUser(api, { ...emptyUserForm(), displayName: 'X' })).kind).toBe('invalid');
    expect(api.create).not.toHaveBeenCalled();
  });
});

describe('profile edits', () => {
  it('sends only changed editable fields; an empty identifier clears it', () => {
    const user = makeUserFull({ phone: '+905321112233' });
    const form = { ...userFormFrom(user), displayName: 'New', phone: '', email: 'x@example.test' };
    expect(updateUserBody(user, form, ['displayName', 'locale'])).toEqual({
      ok: true,
      body: { displayName: 'New' },
    });
    expect(updateUserBody(user, form, editableUserFields(admin, false))).toEqual({
      ok: true,
      body: { displayName: 'New', email: 'x@example.test', phone: null },
    });
    expect(updateUserBody(user, userFormFrom(user), ['displayName'])).toEqual({
      ok: true,
      body: null,
    });
  });
});

describe('membership scope editor', () => {
  it('forces managers and admins to the whole organization', () => {
    expect(
      membershipBody({ role: 'manager', orgWide: false, siteIds: [IDS.site], teamIds: [] }),
    ).toEqual({
      ok: true,
      body: { role: 'manager', orgWide: true, siteIds: [], teamIds: [] },
    });
  });

  it('needs a scope for workers and supervisors, and drops lists when org-wide', () => {
    expect(membershipBody({ role: 'worker', orgWide: false, siteIds: [], teamIds: [] })).toEqual({
      ok: false,
      errors: { scope: 'required' },
    });
    expect(
      membershipBody({ role: 'supervisor', orgWide: true, siteIds: [IDS.site], teamIds: [] }),
    ).toMatchObject({
      ok: true,
      body: { orgWide: true, siteIds: [] },
    });
    expect(
      createMembershipBody(IDS.worker, {
        role: 'worker',
        orgWide: false,
        siteIds: [IDS.site],
        teamIds: [IDS.team],
      }),
    ).toEqual({
      ok: true,
      body: {
        userId: IDS.worker,
        role: 'worker',
        orgWide: false,
        siteIds: [IDS.site],
        teamIds: [IDS.team],
      },
    });
  });
});
