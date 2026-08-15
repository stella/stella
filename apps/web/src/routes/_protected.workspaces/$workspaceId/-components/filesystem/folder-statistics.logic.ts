import { getFirstFile } from "@/components/workspaces/entity-utils";
import type { TableTreeNode } from "@/components/workspaces/table/types";

export type FolderStatistics = {
  fileCount: number;
  totalSizeBytes: number;
};

/**
 * Counts each descendant document row once and sums only the current file that
 * the row represents. Version history and generated derivatives are not part
 * of the tree, so they are deliberately absent from these totals.
 */
export const calculateFolderStatistics = (
  roots: readonly TableTreeNode[],
): ReadonlyMap<TableTreeNode["entityId"], FolderStatistics> => {
  const statisticsByFolderId = new Map<
    TableTreeNode["entityId"],
    FolderStatistics
  >();

  const visit = (node: TableTreeNode): FolderStatistics => {
    if (node.kind !== "folder") {
      return {
        fileCount: 1,
        totalSizeBytes: getFirstFile(node)?.sizeBytes ?? 0,
      };
    }

    let fileCount = 0;
    let totalSizeBytes = 0;

    for (const child of node.children) {
      const childStatistics = visit(child);
      fileCount += childStatistics.fileCount;
      totalSizeBytes += childStatistics.totalSizeBytes;
    }

    const statistics = { fileCount, totalSizeBytes };
    statisticsByFolderId.set(node.entityId, statistics);
    return statistics;
  };

  for (const root of roots) {
    visit(root);
  }

  return statisticsByFolderId;
};
