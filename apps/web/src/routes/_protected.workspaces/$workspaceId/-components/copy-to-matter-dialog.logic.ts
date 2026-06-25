import type { EntityKind } from "@/lib/types";

export type CopyToMatterEntity = {
  entityId: string;
  entityName: string;
  kind: EntityKind;
  /** Ancestor entity IDs from the immediate parent up to the root. The
   *  transfer drops any entity whose ancestor is also selected, since copying
   *  the selected ancestor folder already carries the whole subtree. The chain
   *  must be resolved from a lookup spanning every entity (not just the
   *  selection) so it stays unbroken across unselected intermediate folders. */
  ancestorIds: string[];
};

// Walk the immediate-parent links up to the root. The lookup must span every
// entity so the chain is unbroken even when an intermediate folder is not part
// of the selection; the visited guard stops a cyclic parent link.
export const resolveAncestorIds = (
  entityId: string,
  parentById: ReadonlyMap<string, string | null>,
): string[] => {
  const ancestorIds: string[] = [];
  const visited = new Set<string>([entityId]);
  let parentId = parentById.get(entityId) ?? null;

  while (parentId && !visited.has(parentId)) {
    ancestorIds.push(parentId);
    visited.add(parentId);
    parentId = parentById.get(parentId) ?? null;
  }

  return ancestorIds;
};

export const getCopyToMatterRootEntities = (
  entities: readonly CopyToMatterEntity[],
): CopyToMatterEntity[] => {
  const selectedIds = new Set(entities.map((entity) => entity.entityId));

  return entities.filter(
    (entity) => !entity.ancestorIds.some((id) => selectedIds.has(id)),
  );
};
