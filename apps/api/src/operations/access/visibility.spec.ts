import { contextFor, orgWideContextFor } from './testing';
import { taskVisibility } from './rules/task.rules';
import { userVisibility } from './rules/user.rules';
import { workLogVisibility } from './rules/work-log.rules';
import {
  anyOf,
  isVisible,
  relationIn,
  visibilityWhere,
  type Visibility,
  type WhereFragment,
} from './visibility';

/**
 * A tiny in-memory reading of the Prisma `where` subset the visibility layer produces
 * (`OR`, `{ field: { in } }`, `{ archivedAt: null }`, relation paths through `some`). It lets these tests check that
 * the `where` fragment of a rule selects exactly the records its predicate accepts.
 */
function matchesWhere(where: WhereFragment, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as WhereFragment[]).some((part) => matchesWhere(part, row));
    }
    const value = row[key];
    if (condition === null) {
      return value === null || value === undefined;
    }
    const spec = condition as Record<string, unknown>;
    if ('in' in spec) {
      return typeof value === 'string' && (spec.in as string[]).includes(value);
    }
    if ('some' in spec) {
      return (value as Record<string, unknown>[]).some((child) =>
        matchesWhere(spec.some as WhereFragment, child),
      );
    }
    return matchesWhere(spec as WhereFragment, value as Record<string, unknown>);
  });
}

function agree<Facts>(
  visibility: Visibility<Facts>,
  cases: Array<{ facts: Facts; row: Record<string, unknown> }>,
): void {
  const where = visibilityWhere(visibility);
  for (const { facts, row } of cases) {
    expect(matchesWhere(where, row)).toBe(isVisible(visibility, facts));
  }
}

const ids = ['me', 'u1', 'u2', 's1', 's2', 't1', 't2', 'x'];

describe('visibility: the where fragment and the predicate agree', () => {
  const contexts = [
    contextFor('me', ['worker']),
    contextFor('me', ['supervisor'], { siteIds: ['s1'], teamIds: ['t1'], userIds: ['me', 'u1'] }),
    contextFor('me', ['worker', 'supervisor'], {
      siteIds: ['s2'],
      userIds: ['me', 'u2'],
      colleagueIds: ['me', 'u1'],
    }),
    orgWideContextFor('me', 'manager'),
  ];

  it.each(contexts.map((context, index) => [index, context]))(
    'for work logs (context %i)',
    (_index, context) => {
      const cases = ids.flatMap((authorId) =>
        [null, 's1', 's2'].flatMap((siteId) =>
          [null, 't1', 't2'].map((teamId) => {
            const facts = { authorId, siteId, teamId };
            return { facts, row: facts };
          }),
        ),
      );
      agree(workLogVisibility(context), cases);
    },
  );

  it.each(contexts.map((context, index) => [index, context]))(
    'for tasks (context %i)',
    (_index, context) => {
      const cases = [[], ['me'], ['u1'], ['u2', 'x']].flatMap((assigneeIds) =>
        [null, 's1'].flatMap((siteId) =>
          ['me', 'x'].map((createdById) => {
            const facts = { siteId, teamId: null, createdById, assigneeIds };
            const row = {
              siteId,
              teamId: null,
              createdById,
              assignees: assigneeIds.map((userId) => ({ userId })),
            };
            return { facts, row };
          }),
        ),
      );
      agree(taskVisibility(context), cases);
    },
  );

  it.each(contexts.map((context, index) => [index, context]))(
    'for users (context %i)',
    (_index, context) => {
      // A shared task counts only while it is not archived: the facts are computed from active
      // tasks, and the row keeps the archived one so the where fragment must skip it.
      const cases = ids.flatMap((id) =>
        [
          { peers: [] as string[], archived: false },
          { peers: ['me'], archived: false },
          { peers: ['me'], archived: true },
        ].flatMap(({ peers, archived }) =>
          [false, true].map((created) => {
            const active = archived ? [] : peers;
            const facts = {
              id,
              coAssigneeIds: created ? [] : active,
              createdTaskAssigneeIds: created ? active : [],
            };
            const tasks = peers.map((userId) => ({
              archivedAt: archived ? '2026-01-01T00:00:00.000Z' : null,
              assignees: [{ userId }],
            }));
            const row = {
              id,
              taskAssignments: created ? [] : tasks.map((task) => ({ task })),
              createdTasks: created ? tasks : [],
            };
            return { facts, row };
          }),
        ),
      );
      agree(userVisibility(context), cases);
    },
  );

  it('matches nothing when no clause has an id', () => {
    expect(visibilityWhere({ all: false, anyOf: [] })).toEqual({ id: { in: [] } });
    expect(isVisible({ all: false, anyOf: [] }, { id: 'me' })).toBe(false);
  });

  it('requires records of an active-only relation to be not archived', () => {
    expect(
      visibilityWhere(
        anyOf<{ id: string; peers: string[] }>(
          relationIn(
            'peers',
            ['taskAssignments', 'some', 'task', 'assignees', 'some', 'userId'],
            ['me'],
            {
              activeOnly: ['task'],
            },
          ),
          relationIn('peers', ['tasks', 'some', 'assignees', 'some', 'userId'], ['me'], {
            activeOnly: ['tasks'],
          }),
        ),
      ),
    ).toEqual({
      OR: [
        {
          taskAssignments: {
            some: { task: { archivedAt: null, assignees: { some: { userId: { in: ['me'] } } } } },
          },
        },
        { tasks: { some: { archivedAt: null, assignees: { some: { userId: { in: ['me'] } } } } } },
      ],
    });
  });

  it('adds no condition when everything is visible', () => {
    expect(visibilityWhere({ all: true })).toEqual({});
  });
});
