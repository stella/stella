import { SKELETON_ROW_KEYS } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";

export const GROUP_TABLE_PAGE_SIZE = 200;
const DEFAULT_GROUP_SKELETON_ROW_COUNT = 3;

export const getGroupSkeletonLayout = (totalRowCount: number | undefined) => {
  const rowCount = totalRowCount ?? DEFAULT_GROUP_SKELETON_ROW_COUNT;
  const reservedRowCount = Math.min(rowCount, GROUP_TABLE_PAGE_SIZE);
  const skeletonRowCount = Math.min(reservedRowCount, SKELETON_ROW_KEYS.length);

  return {
    skeletonRowCount,
    fillerRowCount: reservedRowCount - skeletonRowCount,
  };
};
