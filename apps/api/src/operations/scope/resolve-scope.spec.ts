import type { ResolvedScope, Role } from '@ops/shared';
import type { HierarchyNode } from '../common/hierarchy';
import { resolveScope, type ScopeInput, type ScopeMembership } from './resolve-scope';

const ORG = 'org';

// Sites: north > north-yard, south. Teams: electrical > electrical-night, plumbing.
const sites = [
  { id: 'north', parentId: null },
  { id: 'north-yard', parentId: 'north' },
  { id: 'south', parentId: null },
];
const teams = [
  { id: 'electrical', parentId: null },
  { id: 'electrical-night', parentId: 'electrical' },
  { id: 'plumbing', parentId: null },
];

// A deeper tree, used for the hierarchy rules:
//   region > city > depot > bay        region > harbour        island (separate root)
const deepSites: HierarchyNode[] = [
  { id: 'region', parentId: null },
  { id: 'city', parentId: 'region' },
  { id: 'depot', parentId: 'city' },
  { id: 'bay', parentId: 'depot' },
  { id: 'harbour', parentId: 'region' },
  { id: 'island', parentId: null },
];
//   ops > maintenance > hvac > hvac-night        ops > cleaning        sales (separate root)
const deepTeams: HierarchyNode[] = [
  { id: 'ops', parentId: null },
  { id: 'maintenance', parentId: 'ops' },
  { id: 'hvac', parentId: 'maintenance' },
  { id: 'hvac-night', parentId: 'hvac' },
  { id: 'cleaning', parentId: 'ops' },
  { id: 'sales', parentId: null },
];

function membership(
  userId: string,
  role: Role,
  scope: Partial<Pick<ScopeMembership, 'orgWide' | 'archived' | 'siteIds' | 'teamIds'>> = {},
): ScopeMembership {
  return { userId, role, orgWide: false, archived: false, siteIds: [], teamIds: [], ...scope };
}

function resolve(userId: string, memberships: ScopeMembership[], archived = false) {
  const input: ScopeInput = {
    user: { id: userId, organizationId: ORG, archived },
    memberships,
    sites,
    teams,
  };
  return resolveScope(input);
}

function resolveDeep(userId: string, memberships: ScopeMembership[]) {
  return resolveScope({
    user: { id: userId, organizationId: ORG, archived: false },
    memberships,
    sites: deepSites,
    teams: deepTeams,
  });
}

/** The scope of somebody who sees nothing but themselves. */
function selfOnly(userId: string, overrides: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    userId,
    organizationId: ORG,
    active: true,
    roles: [],
    orgWide: false,
    siteIds: [],
    teamIds: [],
    userIds: [userId],
    memberOf: { orgWide: false, siteIds: [], teamIds: [] },
    ...overrides,
  };
}

// A cast of colleagues placed all over the small tree, reused to check who is and is not visible.
const colleagues: ScopeMembership[] = [
  membership('at-north', 'worker', { siteIds: ['north'] }),
  membership('at-yard', 'worker', { siteIds: ['north-yard'] }),
  membership('at-south', 'worker', { siteIds: ['south'] }),
  membership('electrician', 'worker', { teamIds: ['electrical'] }),
  membership('night-electrician', 'worker', { teamIds: ['electrical-night'] }),
  membership('plumber', 'worker', { teamIds: ['plumbing'] }),
  membership('floater', 'worker', { orgWide: true }),
  membership('boss', 'manager', { orgWide: true }),
  membership('root', 'admin', { orgWide: true }),
];

describe('resolveScope', () => {
  describe('no usable membership', () => {
    it('gives a user without memberships only themselves', () => {
      expect(resolve('u', [])).toEqual(selfOnly('u'));
    });

    it('gives a user only themselves when every membership belongs to somebody else', () => {
      expect(resolve('u', colleagues)).toEqual(selfOnly('u'));
    });

    it.each<Role>(['worker', 'supervisor', 'manager', 'admin'])(
      'treats an archived %s membership as no membership at all',
      (role) => {
        const scope = resolve('u', [
          membership('u', role, {
            orgWide: true,
            siteIds: ['north'],
            teamIds: ['plumbing'],
            archived: true,
          }),
          ...colleagues,
        ]);
        expect(scope).toEqual(selfOnly('u'));
      },
    );

    it('ignores archived memberships, the user’s own and other people’s', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['north'], archived: true }),
        membership('sup', 'supervisor', { siteIds: ['south'] }),
        membership('left-south', 'worker', { siteIds: ['south'], archived: true }),
      ]);
      expect(scope.siteIds).toEqual(['south']);
      expect(scope.userIds).toEqual(['sup']);
    });

    it('keeps a colleague visible through an active membership when another of theirs is archived', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['south'] }),
        membership('mover', 'worker', { siteIds: ['south'], archived: true }),
        membership('mover', 'worker', { siteIds: ['south'] }),
      ]);
      expect(scope.userIds).toEqual(['mover', 'sup']);
    });
  });

  describe('archived user', () => {
    it.each<[string, ScopeMembership[]]>([
      ['an organization-wide admin', [membership('gone', 'admin', { orgWide: true })]],
      ['a site supervisor', [membership('gone', 'supervisor', { siteIds: ['north'] })]],
      ['a team worker', [membership('gone', 'worker', { teamIds: ['plumbing'] })]],
      ['an organization-wide worker', [membership('gone', 'worker', { orgWide: true })]],
    ])('gives nothing to an archived user who was %s', (_name, own) => {
      const scope = resolve('gone', [...own, ...colleagues], true);
      expect(scope).toEqual(selfOnly('gone', { active: false }));
    });

    it('reports an active user as active', () => {
      expect(resolve('u', []).active).toBe(true);
    });
  });

  describe('worker', () => {
    it('with no site and no team sees only their own records and belongs nowhere', () => {
      const scope = resolve('worker', [membership('worker', 'worker'), ...colleagues]);
      expect(scope).toEqual(selfOnly('worker', { roles: ['worker'] }));
    });

    it('in one team belongs to that team and does not see team mates', () => {
      const scope = resolve('worker', [
        membership('worker', 'worker', { teamIds: ['plumbing'] }),
        ...colleagues,
      ]);
      expect(scope).toEqual(
        selfOnly('worker', {
          roles: ['worker'],
          memberOf: { orgWide: false, siteIds: [], teamIds: ['plumbing'] },
        }),
      );
      expect(scope.userIds).not.toContain('plumber');
    });

    it('lets a worker in two teams see only their own records and marks where they belong', () => {
      const scope = resolve('worker', [
        membership('worker', 'worker', { teamIds: ['electrical', 'plumbing'] }),
        membership('colleague', 'worker', { teamIds: ['electrical'] }),
      ]);
      expect(scope.roles).toEqual(['worker']);
      expect(scope.userIds).toEqual(['worker']);
      expect(scope.siteIds).toEqual([]);
      expect(scope.teamIds).toEqual([]);
      expect(scope.memberOf.teamIds).toEqual(['electrical', 'electrical-night', 'plumbing']);
    });

    it('in two teams through two separate memberships belongs to both', () => {
      const scope = resolve('worker', [
        membership('worker', 'worker', { teamIds: ['plumbing'] }),
        membership('worker', 'worker', { teamIds: ['electrical-night'] }),
        ...colleagues,
      ]);
      expect(scope.roles).toEqual(['worker']);
      expect(scope.memberOf).toEqual({
        orgWide: false,
        siteIds: [],
        teamIds: ['electrical-night', 'plumbing'],
      });
      expect(scope.memberOf.teamIds).not.toContain('electrical');
      expect(scope.userIds).toEqual(['worker']);
      expect(scope.teamIds).toEqual([]);
    });

    it('assigned to sites belongs to them and their sub-sites, and sees nobody there', () => {
      const scope = resolve('worker', [
        membership('worker', 'worker', { siteIds: ['north'], teamIds: ['plumbing'] }),
        ...colleagues,
      ]);
      expect(scope.memberOf).toEqual({
        orgWide: false,
        siteIds: ['north', 'north-yard'],
        teamIds: ['plumbing'],
      });
      expect(scope.memberOf.siteIds).not.toContain('south');
      expect(scope.siteIds).toEqual([]);
      expect(scope.teamIds).toEqual([]);
      expect(scope.userIds).toEqual(['worker']);
    });

    it('does not widen the view through an organization-wide worker membership', () => {
      const scope = resolve('floater', [
        membership('floater', 'worker', { orgWide: true }),
        membership('at-south', 'worker', { siteIds: ['south'] }),
      ]);
      expect(scope.orgWide).toBe(false);
      expect(scope.userIds).toEqual(['floater']);
      expect(scope.siteIds).toEqual([]);
      expect(scope.teamIds).toEqual([]);
      expect(scope.memberOf).toEqual({ orgWide: true, siteIds: [], teamIds: [] });
    });

    it('is not seen by a fellow worker of the same site and team', () => {
      const scope = resolve('at-north', [
        ...colleagues,
        membership('second-at-north', 'worker', { siteIds: ['north'] }),
      ]);
      expect(scope.userIds).toEqual(['at-north']);
    });
  });

  describe('supervisor', () => {
    it('of a team only sees that team, its sub-teams and their members, and no site', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { teamIds: ['electrical'] }),
        ...colleagues,
      ]);
      expect(scope.roles).toEqual(['supervisor']);
      expect(scope.orgWide).toBe(false);
      expect(scope.teamIds).toEqual(['electrical', 'electrical-night']);
      expect(scope.siteIds).toEqual([]);
      expect(scope.userIds).toEqual(['electrician', 'night-electrician', 'sup']);
      expect(scope.memberOf).toEqual({ orgWide: false, siteIds: [], teamIds: [] });
    });

    it('lets a site supervisor see the site, its sub-sites and the people working there', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['north'] }),
        membership('at-north', 'worker', { siteIds: ['north'] }),
        membership('at-yard', 'worker', { siteIds: ['north-yard'] }),
        membership('at-south', 'worker', { siteIds: ['south'] }),
        membership('boss', 'manager', { orgWide: true }),
      ]);
      expect(scope.orgWide).toBe(false);
      expect(scope.siteIds).toEqual(['north', 'north-yard']);
      expect(scope.teamIds).toEqual([]);
      expect(scope.userIds).toEqual(['at-north', 'at-yard', 'sup']);
    });

    it('of a site only does not see other sites, any team, or people outside the site', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['north'] }),
        ...colleagues,
      ]);
      expect(scope.siteIds).not.toContain('south');
      expect(scope.teamIds).toEqual([]);
      for (const hidden of ['at-south', 'electrician', 'night-electrician', 'plumber']) {
        expect(scope.userIds).not.toContain(hidden);
      }
    });

    it('treats sites and teams on one membership as a union', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['south'], teamIds: ['electrical'] }),
        membership('south-only', 'worker', { siteIds: ['south'] }),
        membership('night-only', 'worker', { teamIds: ['electrical-night'] }),
        membership('plumber', 'worker', { teamIds: ['plumbing'] }),
      ]);
      expect(scope.siteIds).toEqual(['south']);
      expect(scope.teamIds).toEqual(['electrical', 'electrical-night']);
      expect(scope.userIds).toEqual(['night-only', 'south-only', 'sup']);
    });

    it('with site and team on one membership sees people who match only one of the two', () => {
      // An intersection would show only `both`; the rule is a union.
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['south'], teamIds: ['plumbing'] }),
        membership('both', 'worker', { siteIds: ['south'], teamIds: ['plumbing'] }),
        membership('site-only', 'worker', { siteIds: ['south'] }),
        membership('team-only', 'worker', { teamIds: ['plumbing'] }),
        membership('neither', 'worker', { siteIds: ['north'], teamIds: ['electrical'] }),
      ]);
      expect(scope.userIds).toEqual(['both', 'site-only', 'sup', 'team-only']);
      expect(scope.userIds).not.toContain('neither');
      expect(scope.siteIds).toEqual(['south']);
      expect(scope.teamIds).toEqual(['plumbing']);
    });

    it('sees the same data whether site and team sit on one membership or on two', () => {
      const others = [
        membership('site-only', 'worker', { siteIds: ['south'] }),
        membership('team-only', 'worker', { teamIds: ['plumbing'] }),
      ];
      const one = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['south'], teamIds: ['plumbing'] }),
        ...others,
      ]);
      const two = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['south'] }),
        membership('sup', 'supervisor', { teamIds: ['plumbing'] }),
        ...others,
      ]);
      expect(two).toEqual(one);
    });

    it('with no site and no team sees only themselves', () => {
      const scope = resolve('sup', [membership('sup', 'supervisor'), ...colleagues]);
      expect(scope).toEqual(selfOnly('sup', { roles: ['supervisor'] }));
    });

    it('who is organization-wide sees everything', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { orgWide: true }),
        ...colleagues,
      ]);
      expect(scope.orgWide).toBe(true);
      expect(scope.userIds).toBe('all');
      expect(scope.siteIds).toEqual(['north', 'north-yard', 'south']);
      expect(scope.teamIds).toEqual(['electrical', 'electrical-night', 'plumbing']);
    });
  });

  describe('manager and admin', () => {
    it('gives an organization-wide manager everything', () => {
      const scope = resolve('boss', [membership('boss', 'manager', { orgWide: true })]);
      expect(scope.orgWide).toBe(true);
      expect(scope.userIds).toBe('all');
      expect(scope.siteIds).toEqual(['north', 'north-yard', 'south']);
      expect(scope.teamIds).toEqual(['electrical', 'electrical-night', 'plumbing']);
    });

    it('gives an organization-wide admin everything', () => {
      const scope = resolve('root', colleagues);
      expect(scope).toEqual({
        userId: 'root',
        organizationId: ORG,
        active: true,
        roles: ['admin'],
        orgWide: true,
        siteIds: ['north', 'north-yard', 'south'],
        teamIds: ['electrical', 'electrical-night', 'plumbing'],
        userIds: 'all',
        memberOf: { orgWide: false, siteIds: [], teamIds: [] },
      });
    });

    it.each<Role>(['manager', 'admin'])(
      'limits a %s who is scoped to a site to that site',
      (role) => {
        const scope = resolve('scoped', [
          membership('scoped', role, { siteIds: ['south'] }),
          ...colleagues,
        ]);
        expect(scope.roles).toEqual([role]);
        expect(scope.orgWide).toBe(false);
        expect(scope.siteIds).toEqual(['south']);
        expect(scope.teamIds).toEqual([]);
        expect(scope.userIds).toEqual(['at-south', 'scoped']);
        expect(scope.userIds).not.toContain('at-north');
      },
    );

    it('limits an admin scoped to a team to that team and its sub-teams', () => {
      const scope = resolve('scoped', [
        membership('scoped', 'admin', { teamIds: ['electrical'] }),
        ...colleagues,
      ]);
      expect(scope.orgWide).toBe(false);
      expect(scope.teamIds).toEqual(['electrical', 'electrical-night']);
      expect(scope.siteIds).toEqual([]);
      expect(scope.userIds).toEqual(['electrician', 'night-electrician', 'scoped']);
    });

    it.each<Role>(['manager', 'admin'])(
      'gives a %s with neither orgWide nor any scope only themselves',
      (role) => {
        const scope = resolve('bare', [membership('bare', role), ...colleagues]);
        expect(scope).toEqual(selfOnly('bare', { roles: [role] }));
      },
    );

    it('ignores the sites and teams of an organization-wide membership: everything is visible', () => {
      const scope = resolve('boss', [
        membership('boss', 'manager', { orgWide: true, siteIds: ['south'] }),
        ...colleagues,
      ]);
      expect(scope.siteIds).toEqual(['north', 'north-yard', 'south']);
      expect(scope.userIds).toBe('all');
    });
  });

  describe('several memberships', () => {
    it('combines several memberships as a union', () => {
      const scope = resolve('mixed', [
        membership('mixed', 'worker', { teamIds: ['plumbing'] }),
        membership('mixed', 'supervisor', { siteIds: ['south'] }),
        membership('at-south', 'worker', { siteIds: ['south'] }),
        membership('plumber', 'worker', { teamIds: ['plumbing'] }),
      ]);
      expect(scope.roles).toEqual(['worker', 'supervisor']);
      expect(scope.siteIds).toEqual(['south']);
      expect(scope.userIds).toEqual(['at-south', 'mixed']);
      expect(scope.memberOf.teamIds).toEqual(['plumbing']);
    });

    it('keeps the roles apart: worker in team A and supervisor of site B', () => {
      const scope = resolve('mixed', [
        membership('mixed', 'worker', { teamIds: ['electrical'] }),
        membership('mixed', 'supervisor', { siteIds: ['south'] }),
        ...colleagues,
      ]);
      expect(scope).toEqual({
        userId: 'mixed',
        organizationId: ORG,
        active: true,
        roles: ['worker', 'supervisor'],
        orgWide: false,
        // The supervisor membership gives the view...
        siteIds: ['south'],
        // ...and the worker membership gives none: team A is not visible, nor are its members.
        teamIds: [],
        userIds: ['at-south', 'mixed'],
        memberOf: { orgWide: false, siteIds: [], teamIds: ['electrical', 'electrical-night'] },
      });
    });

    it('unions the scopes of two oversight memberships with different roles', () => {
      const scope = resolve('mixed', [
        membership('mixed', 'supervisor', { teamIds: ['plumbing'] }),
        membership('mixed', 'manager', { siteIds: ['north-yard'] }),
        ...colleagues,
      ]);
      expect(scope.roles).toEqual(['supervisor', 'manager']);
      expect(scope.siteIds).toEqual(['north-yard']);
      expect(scope.teamIds).toEqual(['plumbing']);
      // `at-north` is a worker at the parent site, so they work at north-yard too.
      expect(scope.userIds).toEqual(['at-north', 'at-yard', 'mixed', 'plumber']);
    });

    it('becomes organization-wide as soon as one oversight membership is', () => {
      const scope = resolve('mixed', [
        membership('mixed', 'supervisor', { siteIds: ['south'] }),
        membership('mixed', 'manager', { orgWide: true }),
        membership('mixed', 'worker', { teamIds: ['plumbing'] }),
      ]);
      expect(scope.orgWide).toBe(true);
      expect(scope.userIds).toBe('all');
      expect(scope.siteIds).toEqual(['north', 'north-yard', 'south']);
      expect(scope.memberOf).toEqual({ orgWide: false, siteIds: [], teamIds: ['plumbing'] });
    });

    it('does not become organization-wide through an org-wide worker plus a scoped supervisor', () => {
      const scope = resolve('mixed', [
        membership('mixed', 'worker', { orgWide: true }),
        membership('mixed', 'supervisor', { siteIds: ['south'] }),
        ...colleagues,
      ]);
      expect(scope.orgWide).toBe(false);
      expect(scope.siteIds).toEqual(['south']);
      expect(scope.userIds).toEqual(['at-south', 'mixed']);
      expect(scope.memberOf.orgWide).toBe(true);
    });

    it('lists roles once each, in the fixed order worker, supervisor, manager, admin', () => {
      const scope = resolve('all-roles', [
        membership('all-roles', 'admin', { siteIds: ['south'] }),
        membership('all-roles', 'manager', { siteIds: ['south'] }),
        membership('all-roles', 'supervisor', { siteIds: ['south'] }),
        membership('all-roles', 'supervisor', { siteIds: ['north'] }),
        membership('all-roles', 'worker'),
      ]);
      expect(scope.roles).toEqual(['worker', 'supervisor', 'manager', 'admin']);
    });
  });

  describe('hierarchy', () => {
    it('includes every level below a site, and neither its siblings nor its ancestors', () => {
      const scope = resolveDeep('sup', [membership('sup', 'supervisor', { siteIds: ['city'] })]);
      expect(scope.siteIds).toEqual(['bay', 'city', 'depot']);
      for (const hidden of ['region', 'harbour', 'island']) {
        expect(scope.siteIds).not.toContain(hidden);
      }
    });

    it('includes every level below a team, and neither its siblings nor its ancestors', () => {
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { teamIds: ['maintenance'] }),
      ]);
      expect(scope.teamIds).toEqual(['hvac', 'hvac-night', 'maintenance']);
      for (const hidden of ['ops', 'cleaning', 'sales']) {
        expect(scope.teamIds).not.toContain(hidden);
      }
    });

    it('gives a scope on a root everything below it and nothing of another root', () => {
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['region'], teamIds: ['ops'] }),
      ]);
      expect(scope.siteIds).toEqual(['bay', 'city', 'depot', 'harbour', 'region']);
      expect(scope.teamIds).toEqual(['cleaning', 'hvac', 'hvac-night', 'maintenance', 'ops']);
      expect(scope.siteIds).not.toContain('island');
      expect(scope.teamIds).not.toContain('sales');
    });

    it('gives a scope on a leaf only that leaf', () => {
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['bay'], teamIds: ['hvac-night'] }),
      ]);
      expect(scope.siteIds).toEqual(['bay']);
      expect(scope.teamIds).toEqual(['hvac-night']);
    });

    it('does not repeat a node reached through two scopes', () => {
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['city', 'depot'] }),
        membership('sup', 'manager', { siteIds: ['bay'] }),
      ]);
      expect(scope.siteIds).toEqual(['bay', 'city', 'depot']);
    });

    it('shows people scoped to a descendant, at any depth, and not people of a sibling', () => {
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['city'], teamIds: ['maintenance'] }),
        membership('at-bay', 'worker', { siteIds: ['bay'] }),
        membership('at-harbour', 'worker', { siteIds: ['harbour'] }),
        membership('at-island', 'worker', { siteIds: ['island'] }),
        membership('night-hvac', 'worker', { teamIds: ['hvac-night'] }),
        membership('cleaner', 'worker', { teamIds: ['cleaning'] }),
      ]);
      expect(scope.userIds).toEqual(['at-bay', 'night-hvac', 'sup']);
    });

    it('shows workers of an ancestor site or team, but not the oversight roles above', () => {
      // A worker assigned to `region` belongs to `city` too (rule 2), so the supervisor of
      // `city` sees them. The regional manager holds authority, not belonging, and stays hidden.
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['city'], teamIds: ['maintenance'] }),
        membership('region-worker', 'worker', { siteIds: ['region'] }),
        membership('ops-worker', 'worker', { teamIds: ['ops'] }),
        membership('region-manager', 'manager', { siteIds: ['region'] }),
      ]);
      expect(scope.userIds).toEqual(['ops-worker', 'region-worker', 'sup']);
      expect(scope.userIds).not.toContain('region-manager');
    });

    it('shows a worker of an ancestor several levels up to the supervisor of a leaf', () => {
      // region > city > depot > bay: the bay supervisor sees workers of every level above.
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['bay'], teamIds: ['hvac-night'] }),
        membership('region-worker', 'worker', { siteIds: ['region'] }),
        membership('city-worker', 'worker', { siteIds: ['city'] }),
        membership('depot-worker', 'worker', { siteIds: ['depot'] }),
        membership('bay-worker', 'worker', { siteIds: ['bay'] }),
        membership('ops-worker', 'worker', { teamIds: ['ops'] }),
        membership('hvac-worker', 'worker', { teamIds: ['hvac'] }),
      ]);
      expect(scope.userIds).toEqual([
        'bay-worker',
        'city-worker',
        'depot-worker',
        'hvac-worker',
        'ops-worker',
        'region-worker',
        'sup',
      ]);
      // Seeing the people does not widen the places: only the leaf is visible.
      expect(scope.siteIds).toEqual(['bay']);
      expect(scope.teamIds).toEqual(['hvac-night']);
    });

    it('does not show workers of a sibling branch, another root, or a descendant of a sibling', () => {
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['depot'], teamIds: ['hvac'] }),
        membership('harbour-worker', 'worker', { siteIds: ['harbour'] }),
        membership('island-worker', 'worker', { siteIds: ['island'] }),
        membership('cleaning-worker', 'worker', { teamIds: ['cleaning'] }),
        membership('sales-worker', 'worker', { teamIds: ['sales'] }),
      ]);
      expect(scope.userIds).toEqual(['sup']);
    });

    it.each<Role>(['supervisor', 'manager', 'admin'])(
      'does not show a %s scoped to an ancestor to the supervisor of a child site or team',
      (role) => {
        const scope = resolveDeep('sup', [
          membership('sup', 'supervisor', { siteIds: ['depot'], teamIds: ['hvac'] }),
          membership('above-site', role, { siteIds: ['region'] }),
          membership('above-site-2', role, { siteIds: ['city'] }),
          membership('above-team', role, { teamIds: ['ops'] }),
          membership('region-worker', 'worker', { siteIds: ['region'] }),
        ]);
        expect(scope.userIds).toEqual(['region-worker', 'sup']);
        for (const hidden of ['above-site', 'above-site-2', 'above-team']) {
          expect(scope.userIds).not.toContain(hidden);
        }
      },
    );

    it('still shows an oversight member scoped directly to the visible node or below it', () => {
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['city'] }),
        membership('city-supervisor', 'supervisor', { siteIds: ['city'] }),
        membership('bay-manager', 'manager', { siteIds: ['bay'] }),
        membership('region-admin', 'admin', { siteIds: ['region'] }),
      ]);
      expect(scope.userIds).toEqual(['bay-manager', 'city-supervisor', 'sup']);
    });

    it('shows somebody who is a worker at an ancestor and also holds an oversight role there', () => {
      // The worker membership is what makes them visible; the oversight one alone would not.
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['depot'] }),
        membership('both', 'manager', { siteIds: ['region'] }),
        membership('both', 'worker', { siteIds: ['region'] }),
        membership('manager-only', 'manager', { siteIds: ['region'] }),
      ]);
      expect(scope.userIds).toEqual(['both', 'sup']);
    });

    it('ignores an archived worker membership at an ancestor, and an org-wide worker', () => {
      const scope = resolveDeep('sup', [
        membership('sup', 'supervisor', { siteIds: ['depot'] }),
        membership('left', 'worker', { siteIds: ['region'], archived: true }),
        membership('floater', 'worker', { orgWide: true }),
      ]);
      expect(scope.userIds).toEqual(['sup']);
    });

    it('does not let a worker at an ancestor see anybody: the rule is about being seen', () => {
      const scope = resolveDeep('region-worker', [
        membership('region-worker', 'worker', { siteIds: ['region'] }),
        membership('sup', 'supervisor', { siteIds: ['depot'] }),
        membership('bay-worker', 'worker', { siteIds: ['bay'] }),
      ]);
      expect(scope.userIds).toEqual(['region-worker']);
      expect(scope.siteIds).toEqual([]);
    });

    it('passes worker membership down the tree as well', () => {
      const scope = resolveDeep('worker', [
        membership('worker', 'worker', { siteIds: ['depot'], teamIds: ['hvac'] }),
      ]);
      expect(scope.memberOf).toEqual({
        orgWide: false,
        siteIds: ['bay', 'depot'],
        teamIds: ['hvac', 'hvac-night'],
      });
    });

    it('survives a cycle in the hierarchy', () => {
      const scope = resolveScope({
        user: { id: 'sup', organizationId: ORG, archived: false },
        memberships: [membership('sup', 'supervisor', { siteIds: ['a'] })],
        sites: [
          { id: 'a', parentId: 'b' },
          { id: 'b', parentId: 'a' },
        ],
        teams: [],
      });
      expect(scope.siteIds).toEqual(['a', 'b']);
    });

    it('keeps a scoped id that is not in the tree, without inventing descendants', () => {
      const scope = resolve('sup', [membership('sup', 'supervisor', { siteIds: ['unknown'] })]);
      expect(scope.siteIds).toEqual(['unknown']);
    });
  });

  describe('visible users', () => {
    it('always lists the user themselves, even when they hold no membership in their scope', () => {
      const scope = resolve('sup', [membership('sup', 'supervisor', { siteIds: ['south'] })]);
      expect(scope.userIds).toEqual(['sup']);
    });

    it('lists colleagues of any role who are scoped to a visible site or team', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['south'] }),
        membership('south-worker', 'worker', { siteIds: ['south'] }),
        membership('south-supervisor', 'supervisor', { siteIds: ['south'] }),
        membership('south-manager', 'manager', { siteIds: ['south', 'north'] }),
        membership('south-admin', 'admin', { siteIds: ['south'] }),
        membership('north-supervisor', 'supervisor', { siteIds: ['north'] }),
      ]);
      expect(scope.userIds).toEqual([
        'south-admin',
        'south-manager',
        'south-supervisor',
        'south-worker',
        'sup',
      ]);
      expect(scope.userIds).not.toContain('north-supervisor');
    });

    it('does not pull an organization-wide member of any role into a site supervisor’s list', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['north'] }),
        membership('floater', 'worker', { orgWide: true }),
        membership('wide-supervisor', 'supervisor', { orgWide: true }),
        membership('boss', 'manager', { orgWide: true }),
        membership('root', 'admin', { orgWide: true }),
      ]);
      expect(scope.userIds).toEqual(['sup']);
    });

    it('lists an organization-wide member who is also scoped to the visible site', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['north'] }),
        membership('boss', 'manager', { orgWide: true, siteIds: ['north-yard'] }),
      ]);
      expect(scope.userIds).toEqual(['boss', 'sup']);
    });

    it('is the word all, not a list, when the view is organization-wide', () => {
      const scope = resolve('boss', colleagues);
      expect(scope.userIds).toBe('all');
    });

    it('lists each colleague once however many memberships match', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['south'], teamIds: ['plumbing'] }),
        membership('busy', 'worker', { siteIds: ['south'], teamIds: ['plumbing'] }),
        membership('busy', 'supervisor', { teamIds: ['plumbing'] }),
      ]);
      expect(scope.userIds).toEqual(['busy', 'sup']);
    });
  });

  describe('archived sites and teams', () => {
    // The pure function is given every site and team, archived ones included, and has no
    // archived flag for them: an archived site or team still counts as scope (see the doc
    // comment of resolveScope). ScopeService loads them without filtering on archivedAt; the
    // integration suite checks that end to end.
    it('has no notion of an archived site: whatever tree it is given counts in full', () => {
      const scope = resolve('sup', [
        membership('sup', 'supervisor', { siteIds: ['north'] }),
        membership('at-yard', 'worker', { siteIds: ['north-yard'] }),
      ]);
      expect(scope.siteIds).toEqual(['north', 'north-yard']);
      expect(scope.userIds).toEqual(['at-yard', 'sup']);
    });
  });

  describe('result shape', () => {
    it('sorts the id lists, so equal scopes compare equal whatever the input order', () => {
      const memberships = [
        membership('sup', 'supervisor', {
          siteIds: ['south', 'north'],
          teamIds: ['plumbing', 'electrical'],
        }),
        membership('zed', 'worker', { siteIds: ['south'] }),
        membership('amy', 'worker', { teamIds: ['plumbing'] }),
      ];
      const forwards = resolve('sup', memberships);
      const backwards = resolveScope({
        user: { id: 'sup', organizationId: ORG, archived: false },
        memberships: [...memberships].reverse(),
        sites: [...sites].reverse(),
        teams: [...teams].reverse(),
      });
      expect(forwards.siteIds).toEqual(['north', 'north-yard', 'south']);
      expect(forwards.teamIds).toEqual(['electrical', 'electrical-night', 'plumbing']);
      expect(forwards.userIds).toEqual(['amy', 'sup', 'zed']);
      expect(backwards).toEqual(forwards);
    });

    it('does not change its input', () => {
      const memberships = [membership('sup', 'supervisor', { siteIds: ['south', 'north'] })];
      const snapshot = JSON.stringify({ memberships, sites, teams });
      resolve('sup', memberships);
      expect(JSON.stringify({ memberships, sites, teams })).toBe(snapshot);
    });

    it('carries the user id and the organization id through', () => {
      const scope = resolveScope({
        user: { id: 'u-9', organizationId: 'org-9', archived: false },
        memberships: [],
        sites: [],
        teams: [],
      });
      expect(scope.userId).toBe('u-9');
      expect(scope.organizationId).toBe('org-9');
    });
  });
});
