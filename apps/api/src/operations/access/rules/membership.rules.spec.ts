import { contextFor, orgWideContextFor } from '../testing';
import {
  canGrantMembership,
  canRemoveAdmin,
  isMembershipReduced,
  type MembershipGrant,
} from './membership.rules';

// The generic "no privilege escalation" rule. Over HTTP only admins reach the membership routes
// (route policy `membership.manage`), so the rule for any other granter is exercised here.

function grant(overrides: Partial<MembershipGrant> = {}): MembershipGrant {
  return { role: 'worker', orgWide: false, siteIds: [], teamIds: [], ...overrides };
}

const siteSupervisor = contextFor('sup', ['supervisor'], {
  siteIds: ['north', 'north-yard'],
  teamIds: ['electrical'],
});
const orgWideSupervisor = contextFor('osup', ['supervisor'], { orgWide: true, userIds: 'all' });
const worker = contextFor('w', ['worker']);
const manager = orgWideContextFor('m', 'manager');
const admin = orgWideContextFor('a', 'admin');
const nobody = contextFor('n', []);

describe('canGrantMembership: never a role above one’s own', () => {
  it.each([
    ['a worker', worker, 'worker', true],
    ['a worker', worker, 'supervisor', false],
    ['a supervisor', orgWideSupervisor, 'supervisor', true],
    ['a supervisor', orgWideSupervisor, 'manager', false],
    ['a manager', manager, 'manager', true],
    ['a manager', manager, 'admin', false],
    ['an admin', admin, 'admin', true],
    ['someone without a role', nobody, 'worker', false],
  ] as const)('%s granting %s: %s', (_name, context, role, allowed) => {
    expect(canGrantMembership(context, grant({ role })).allowed).toBe(allowed);
  });

  it('refuses a role that is not a role at all', () => {
    expect(canGrantMembership(admin, grant({ role: 'owner' as never })).allowed).toBe(false);
  });

  it('answers 403 (forbidden), not 404 or 409', () => {
    expect(canGrantMembership(worker, grant({ role: 'admin' }))).toMatchObject({
      allowed: false,
      outcome: 'forbidden',
    });
  });
});

describe('canGrantMembership: never a scope outside one’s own', () => {
  it('lets a scoped granter grant inside their scope, descendants included', () => {
    expect(canGrantMembership(siteSupervisor, grant({ siteIds: ['north-yard'] })).allowed).toBe(
      true,
    );
    expect(
      canGrantMembership(siteSupervisor, grant({ siteIds: ['north'], teamIds: ['electrical'] }))
        .allowed,
    ).toBe(true);
  });

  it.each([
    ['a site outside it', grant({ siteIds: ['south'] })],
    ['one site inside and one outside', grant({ siteIds: ['north', 'south'] })],
    ['a team outside it', grant({ teamIds: ['plumbing'] })],
    ['the whole organization', grant({ orgWide: true })],
  ])('refuses a scoped granter %s', (_name, wanted) => {
    expect(canGrantMembership(siteSupervisor, wanted)).toMatchObject({
      allowed: false,
      outcome: 'forbidden',
    });
  });

  it('lets an organization-wide granter grant any scope (at or below their role)', () => {
    expect(canGrantMembership(orgWideSupervisor, grant({ orgWide: true })).allowed).toBe(true);
    expect(canGrantMembership(admin, grant({ role: 'manager', orgWide: true })).allowed).toBe(true);
  });
});

describe('canRemoveAdmin: the last active admin stays', () => {
  const holders = [
    { membershipId: 'm1', userId: 'a1' },
    { membershipId: 'm2', userId: 'a2' },
  ];

  it('allows removing one admin while another remains', () => {
    expect(canRemoveAdmin(holders, { membershipId: 'm1' }).allowed).toBe(true);
    expect(canRemoveAdmin(holders, { userId: 'a2' }).allowed).toBe(true);
  });

  it('refuses (409) removing the only one, by membership or by user', () => {
    const one = [holders[0]!];
    expect(canRemoveAdmin(one, { membershipId: 'm1' })).toMatchObject({
      allowed: false,
      outcome: 'conflict',
    });
    expect(canRemoveAdmin(one, { userId: 'a1' }).allowed).toBe(false);
  });

  it('refuses removing a user who holds every admin membership', () => {
    const sameUser = [
      { membershipId: 'm1', userId: 'a1' },
      { membershipId: 'm2', userId: 'a1' },
    ];
    expect(canRemoveAdmin(sameUser, { userId: 'a1' }).allowed).toBe(false);
    expect(canRemoveAdmin(sameUser, { membershipId: 'm1' }).allowed).toBe(true);
  });

  it('allows a change that removes no admin at all', () => {
    expect(canRemoveAdmin([holders[0]!], { membershipId: 'other' }).allowed).toBe(true);
    expect(canRemoveAdmin([], { userId: 'a1' }).allowed).toBe(true);
  });
});

describe('isMembershipReduced: when the holder’s sessions must end', () => {
  const before = grant({ role: 'supervisor', siteIds: ['north'], teamIds: ['electrical'] });

  it.each([
    ['a lower role', { role: 'worker' as const }],
    ['a site removed', { siteIds: [] }],
    ['a team removed', { teamIds: [] }],
    ['a site replaced', { siteIds: ['south'] }],
  ])('is true for %s', (_name, change) => {
    expect(isMembershipReduced(before, { ...before, ...change })).toBe(true);
  });

  it('is true when organization-wide scope is taken away', () => {
    const wide = grant({ role: 'supervisor', orgWide: true });
    expect(isMembershipReduced(wide, { ...wide, orgWide: false, siteIds: ['north'] })).toBe(true);
  });

  it.each([
    ['nothing changed', {}],
    ['a higher role', { role: 'manager' as const }],
    ['a site added', { siteIds: ['north', 'south'] }],
    ['organization-wide added', { orgWide: true }],
  ])('is false for %s', (_name, change) => {
    expect(isMembershipReduced(before, { ...before, ...change })).toBe(false);
  });
});
