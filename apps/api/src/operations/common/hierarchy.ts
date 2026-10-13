/** A node of a site or team tree. */
export interface HierarchyNode {
  id: string;
  parentId: string | null;
}

/**
 * The given nodes plus everything below them. Safe on malformed data: a cycle is walked once.
 * Ids that are not in `nodes` are kept as they are (they simply have no children).
 */
export function withDescendants(
  nodes: readonly HierarchyNode[],
  rootIds: Iterable<string>,
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId !== null) {
      const siblings = childrenOf.get(node.parentId);
      if (siblings) {
        siblings.push(node.id);
      } else {
        childrenOf.set(node.parentId, [node.id]);
      }
    }
  }

  const result = new Set<string>();
  const queue = [...rootIds];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (!result.has(id)) {
      result.add(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }
  }
  return result;
}

/**
 * Would giving node `id` the parent `parentId` create a cycle? True when the new parent is the
 * node itself or lies somewhere below it.
 */
export function createsCycle(
  nodes: readonly HierarchyNode[],
  id: string,
  parentId: string,
): boolean {
  return withDescendants(nodes, [id]).has(parentId);
}
