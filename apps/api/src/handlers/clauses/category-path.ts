import type { SafeId } from "@/api/lib/branded-types";

type ClauseCategoryNode = {
  id: SafeId<"clauseCategory">;
  name: string;
  parentId: SafeId<"clauseCategory"> | null;
};

/**
 * Walk a category up to its root, returning the names ordered
 * root-first. The `visited` guard makes the traversal cycle-safe:
 * a corrupted `parentId` chain (self-reference or loop) stops at the
 * first repeat instead of looping forever. Returns `null` when there
 * is no category, a missing link breaks the chain before any name is
 * collected, or the resulting path is empty.
 */
export const buildClauseCategoryPath = (
  categoryMap: ReadonlyMap<SafeId<"clauseCategory">, ClauseCategoryNode>,
  catId: SafeId<"clauseCategory"> | null,
): string[] | null => {
  if (!catId) {
    return null;
  }
  const path: string[] = [];
  let current: SafeId<"clauseCategory"> | null = catId;
  const visited = new Set<SafeId<"clauseCategory">>();
  while (current) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);
    const cat = categoryMap.get(current);
    if (!cat) {
      break;
    }
    path.unshift(cat.name);
    current = cat.parentId;
  }
  return path.length > 0 ? path : null;
};
