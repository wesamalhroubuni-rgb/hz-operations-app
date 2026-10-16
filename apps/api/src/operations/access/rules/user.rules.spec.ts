import { contextFor, orgWideContextFor } from '../testing';
import { canSeeSite } from './place.rules';
import { canRemoveAdmin, canGrantMembership, isMembershipReduced } from './membership.rules';
import { organizationView } from './organization.rules';
import { canSeeUser, canUpdateUser, seesEveryContact, userProfileLevel } from './user.rules';

const worker = contextFor('worker', ['worker'], {
  colleagueIds: ['worker', 'teammate'],
  memberOf: { orgWide: false, siteIds: ['depot'], teamIds: [] },
});
const supervisor = contextFor('sup', ['supervisor'], {
  siteIds: ['depot'],
  userIds: ['sup', 'worker'],
});
const manager = orgWideContextFor('boss', 'manager');
const admin = orgWideContextFor('root', 'admin');
const user = (id: string, coAssigneeIds: string[] = []) => ({
  id,
  coAssigneeIds,
  createdTaskAssigneeIds: [],
});

describe('who sees which user, in which shape', () => {
  it('shows a worker their colleagues and task peers as basic profiles, and nobody else', () => {
    expect(canSeeUser(worker, user('teammate'))).toBe(true);
    expect(canSeeUser(worker, user('peer', ['worker']))).toBe(true);
    expect(canSeeUser(worker, user('stranger'))).toBe(false);
    expect(userProfileLevel(worker, 'teammate')).toBe('basic');
    expect(userProfileLevel(worker, 'worker')).toBe('full');
  });

  it('gives a supervisor the contact profile of their people only', () => {
    expect(userProfileLevel(supervisor, 'worker')).toBe('contact');
    expect(userProfileLevel(supervisor, 'someone-else')).toBe('basic');
    expect(seesEveryContact(supervisor)).toBe(false);
  });

  it('gives a manager contact profiles and an admin full profiles of everyone', () => {
    expect(userProfileLevel(manager, 'anyone')).toBe('contact');
    expect(userProfileLevel(admin, 'anyone')).toBe('full');
    expect(seesEveryContact(manager)).toBe(true);
  });

  it('lets only an admin change another user, and anyone their own display name', () => {
    expect(canUpdateUser(admin, 'worker', ['email', 'username']).allowed).toBe(true);
    expect(canUpdateUser(worker, 'worker', ['displayName']).allowed).toBe(true);
    expect(canUpdateUser(worker, 'worker', ['displayName', 'email'])).toMatchObject({
      outcome: 'forbidden',
    });
    expect(canUpdateUser(manager, 'worker', ['displayName'])).toMatchObject({
      outcome: 'forbidden',
    });
  });
});

describe('sites and organization', () => {
  it('shows a worker the sites they belong to and those of their tasks', () => {
    expect(canSeeSite(worker, { id: 'depot', taskAssigneeIds: [] })).toBe(true);
    expect(canSeeSite(worker, { id: 'harbour', taskAssigneeIds: ['worker'] })).toBe(true);
    expect(canSeeSite(worker, { id: 'harbour', taskAssigneeIds: [] })).toBe(false);
    expect(canSeeSite(manager, { id: 'harbour', taskAssigneeIds: [] })).toBe(true);
  });

  it('shows the organization settings to admins only', () => {
    expect(organizationView(admin)).toBe('full');
    expect(organizationView(manager)).toBe('summary');
  });
});

describe('memberships: no privilege escalation', () => {
  const grant = { orgWide: false, siteIds: [] as string[], teamIds: [] as string[] };

  it('never grants a role above the granter’s own', () => {
    expect(canGrantMembership(manager, { ...grant, role: 'admin', orgWide: true })).toMatchObject({
      outcome: 'forbidden',
    });
    expect(canGrantMembership(manager, { ...grant, role: 'manager', orgWide: true }).allowed).toBe(
      true,
    );
    expect(canGrantMembership(admin, { ...grant, role: 'admin', orgWide: true }).allowed).toBe(
      true,
    );
  });

  it('never grants a scope outside the granter’s own', () => {
    expect(
      canGrantMembership(supervisor, { ...grant, role: 'worker', siteIds: ['depot'] }).allowed,
    ).toBe(true);
    expect(
      canGrantMembership(supervisor, { ...grant, role: 'worker', siteIds: ['harbour'] }),
    ).toMatchObject({ outcome: 'forbidden' });
    expect(
      canGrantMembership(supervisor, { ...grant, role: 'worker', orgWide: true }),
    ).toMatchObject({ outcome: 'forbidden' });
    expect(canGrantMembership(contextFor('nobody', []), { ...grant, role: 'worker' }).allowed).toBe(
      false,
    );
  });

  it('keeps the last active admin', () => {
    const one = [{ membershipId: 'm1', userId: 'root' }];
    const two = [...one, { membershipId: 'm2', userId: 'other' }];
    expect(canRemoveAdmin(one, { membershipId: 'm1' })).toMatchObject({ outcome: 'conflict' });
    expect(canRemoveAdmin(one, { userId: 'root' })).toMatchObject({ outcome: 'conflict' });
    expect(canRemoveAdmin(two, { userId: 'root' }).allowed).toBe(true);
    expect(canRemoveAdmin(one, { userId: 'somebody-else' }).allowed).toBe(true);
    // Two admin memberships of the same user are still one admin.
    const sameUser = [...one, { membershipId: 'm3', userId: 'root' }];
    expect(canRemoveAdmin(sameUser, { membershipId: 'm1' }).allowed).toBe(true);
    expect(canRemoveAdmin(sameUser, { userId: 'root' })).toMatchObject({ outcome: 'conflict' });
  });

  it('knows when an update takes something away', () => {
    const before = {
      role: 'supervisor' as const,
      orgWide: false,
      siteIds: ['a', 'b'],
      teamIds: [],
    };
    expect(isMembershipReduced(before, { ...before, role: 'worker' })).toBe(true);
    expect(isMembershipReduced(before, { ...before, siteIds: ['a'] })).toBe(true);
    expect(isMembershipReduced(before, { ...before, siteIds: ['a', 'b', 'c'] })).toBe(false);
    expect(
      isMembershipReduced(before, { ...before, role: 'manager', orgWide: true, siteIds: [] }),
    ).toBe(true);
  });
});
