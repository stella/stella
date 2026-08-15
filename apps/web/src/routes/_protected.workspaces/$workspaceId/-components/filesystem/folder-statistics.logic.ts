import { getFirstFile } from "@/components/workspaces/entity-utils";
import type { WorkspaceEntity } from "@/lib/types";

export type FolderStatistics = {
  fileCount: number;
  totalSizeBytes: number;
};

type FolderAncestorLink = {
  entityId: string;
  parentId: string | null;
};

const EMPTY_STATISTICS = {
  fileCount: 0,
  totalSizeBytes: 0,
} as const satisfies FolderStatistics;

/**
 * Counts each descendant document row once and sums only the current file that
 * the row represents. Ancestor links reconnect filtered results through hidden
 * intermediate folders without making those folders count as matches. Version
 * history and generated derivatives are deliberately absent from these totals.
 */
export const calculateFolderStatistics = (
  entities: readonly WorkspaceEntity[],
  ancestorLinks: readonly FolderAncestorLink[],
): ReadonlyMap<string, FolderStatistics> => {
  const entityById = new Map(
    entities.map((entity) => [entity.entityId, entity] as const),
  );
  const parentById = new Map<string, string | null>();
  const folderIds = new Set<string>();

  for (const link of ancestorLinks) {
    parentById.set(link.entityId, link.parentId);
    folderIds.add(link.entityId);
  }
  for (const entity of entities) {
    parentById.set(entity.entityId, entity.parentId);
    if (entity.kind === "folder") {
      folderIds.add(entity.entityId);
    }
  }

  const childrenByParentId = new Map<string, string[]>();
  for (const [entityId, parentId] of parentById) {
    if (parentId === null) {
      continue;
    }
    const children = childrenByParentId.get(parentId);
    if (children) {
      children.push(entityId);
    } else {
      childrenByParentId.set(parentId, [entityId]);
    }
  }

  const memo = new Map<string, FolderStatistics>();
  const visiting = new Set<string>();
  const visit = (entityId: string): FolderStatistics => {
    const cached = memo.get(entityId);
    if (cached) {
      return cached;
    }
    if (visiting.has(entityId)) {
      return EMPTY_STATISTICS;
    }

    visiting.add(entityId);
    const entity = entityById.get(entityId);
    let statistics: FolderStatistics;

    if (!entity || entity.kind === "folder") {
      let fileCount = 0;
      let totalSizeBytes = 0;
      for (const childId of childrenByParentId.get(entityId) ?? []) {
        const childStatistics = visit(childId);
        fileCount += childStatistics.fileCount;
        totalSizeBytes += childStatistics.totalSizeBytes;
      }
      statistics = { fileCount, totalSizeBytes };
    } else {
      switch (entity.kind) {
        case "document":
          statistics = {
            fileCount: 1,
            totalSizeBytes: getFirstFile(entity)?.sizeBytes ?? 0,
          };
          break;
        case "link":
        case "message":
        case "task":
          statistics = EMPTY_STATISTICS;
          break;
        default:
          return entity.kind satisfies never;
      }
    }

    visiting.delete(entityId);
    memo.set(entityId, statistics);
    return statistics;
  };

  const statisticsByFolderId = new Map<string, FolderStatistics>();
  for (const folderId of folderIds) {
    statisticsByFolderId.set(folderId, visit(folderId));
  }
  return statisticsByFolderId;
};
