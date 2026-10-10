import { isFileProperty } from "@stll/api-contract/property-policy";

import { propertyAiCellState } from "@/components/workspaces/ai-cell-state.logic";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";

export const canEditPropertyViaComposer = (
  content: { type: string },
  isVerdict: boolean,
): boolean => !isFileProperty(content) && !isVerdict;

type EntityIdRow = {
  original: {
    entityId: string;
  };
};

export const getEntityIdsOrderFromRows = (
  rows: readonly EntityIdRow[],
): string[] => {
  const entityIds: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const { entityId } = row.original;
    if (seen.has(entityId)) {
      continue;
    }

    seen.add(entityId);
    entityIds.push(entityId);
  }

  return entityIds;
};

type PropertyRunRow = {
  original: Pick<
    WorkspaceEntity,
    "cellMetadata" | "entityId" | "fields" | "kind" | "readOnly"
  >;
};

type PropertyRunTargetsOptions = {
  action: "available" | "remaining" | "rerun";
  propertyId: WorkspaceProperty["id"];
  rowIds?: readonly string[];
  rows: readonly PropertyRunRow[];
};

export const getPropertyRunTargetIds = ({
  action,
  propertyId,
  rowIds,
  rows,
}: PropertyRunTargetsOptions): string[] => {
  const rowIdFilter = rowIds === undefined ? null : new Set(rowIds);
  const entityIds: string[] = [];
  for (const row of rows) {
    const entity = row.original;
    if (
      entity.kind === "folder" ||
      entity.readOnly ||
      entity.cellMetadata[propertyId]?.locked === true ||
      (rowIdFilter !== null && !rowIdFilter.has(entity.entityId))
    ) {
      continue;
    }

    const cellState = propertyAiCellState(
      entity.fields[propertyId]?.content,
    ).type;
    if (
      action === "remaining" &&
      cellState !== "not_run" &&
      cellState !== "failed" &&
      cellState !== "refused_budget"
    ) {
      continue;
    }
    if (
      action === "rerun" &&
      (cellState === "queued" || cellState === "running")
    ) {
      continue;
    }
    entityIds.push(entity.entityId);
  }

  return entityIds;
};
