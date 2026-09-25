import type { TableTreeNode } from "@/components/workspaces/table/types";

export type FlattenedFilesystemRow = {
  node: TableTreeNode;
  depth: number;
  ancestorIds: Set<string>;
};

export const flattenFilesystemRows = (
  roots: readonly TableTreeNode[],
  expandedIds: ReadonlySet<string>,
): FlattenedFilesystemRow[] => {
  const rows: FlattenedFilesystemRow[] = [];

  const visit = (
    nodes: readonly TableTreeNode[],
    depth: number,
    ancestorIds: Set<string>,
  ) => {
    for (const node of nodes) {
      rows.push({ node, depth, ancestorIds });

      if (node.kind !== "folder" || !expandedIds.has(node.entityId)) {
        continue;
      }

      const childAncestorIds = new Set(ancestorIds);
      childAncestorIds.add(node.entityId);
      visit(node.children, depth + 1, childAncestorIds);
    }
  };

  visit(roots, 0, new Set());

  return rows;
};

export type FilesystemReveal = {
  expandedIds: Set<string>;
  rowIndex: number;
};

/** Where a revealed entity lands in the tree: its ancestors (and the entity
 * itself, when it is a folder) expanded, plus its row in the flattened list.
 * Null when the entity is not among the rendered nodes, e.g. filtered out. */
export const planFilesystemReveal = ({
  ancestorIds,
  entityId,
  expandedIds,
  roots,
}: {
  ancestorIds: readonly string[];
  entityId: string;
  expandedIds: ReadonlySet<string>;
  roots: readonly TableTreeNode[];
}): FilesystemReveal | null => {
  const nextExpandedIds = new Set([...expandedIds, ...ancestorIds, entityId]);
  const rowIndex = flattenFilesystemRows(roots, nextExpandedIds).findIndex(
    (row) => row.node.entityId === entityId,
  );
  if (rowIndex === -1) {
    return null;
  }
  return { expandedIds: nextExpandedIds, rowIndex };
};
