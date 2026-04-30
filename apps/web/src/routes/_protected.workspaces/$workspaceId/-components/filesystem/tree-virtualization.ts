import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

export type FlattenedFilesystemRow = {
  node: TableTreeNode;
  depth: number;
  ancestorIds: Set<string>;
  guideDepths: number[];
  isLast: boolean;
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
    guideDepths: number[],
  ) => {
    for (const [index, node] of nodes.entries()) {
      const isLast = index === nodes.length - 1;
      rows.push({ node, depth, ancestorIds, guideDepths, isLast });

      if (node.kind !== "folder" || !expandedIds.has(node.entityId)) {
        continue;
      }

      const childAncestorIds = new Set(ancestorIds);
      childAncestorIds.add(node.entityId);
      visit(
        node.children,
        depth + 1,
        childAncestorIds,
        isLast ? guideDepths : [...guideDepths, depth],
      );
    }
  };

  visit(roots, 0, new Set(), []);

  return rows;
};
