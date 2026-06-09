import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

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
