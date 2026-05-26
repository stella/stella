import { useEffect, useState } from "react";

import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import type { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const bottomRowClassName = `sticky bottom-0 z-20 cursor-pointer ${TOOLBAR_ROW_HEIGHT}`;
const FLASH_DURATION_MS = 900;

type BottomRowProps = {
  workspaceId: string;
  table: WorkspaceTable;
  onFolderCreated?: ((entityId: string) => void) | undefined;
  /**
   * Incremented by the parent table when the user right-clicks or
   * double-clicks the empty area below the rows: each change triggers
   * a one-shot flash that points them at this canonical upload
   * affordance instead of opening a redundant context menu.
   */
  flashSeq?: number | undefined;
};

export const BottomRow = ({
  workspaceId,
  table,
  onFolderCreated,
  flashSeq = 0,
}: BottomRowProps) => {
  const t = useTranslations();
  const [isFlashing, setIsFlashing] = useState(false);

  useEffect(() => {
    if (flashSeq === 0) {
      return undefined;
    }
    setIsFlashing(true);
    const timer = setTimeout(() => setIsFlashing(false), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flashSeq]);

  return (
    <AddEntityMenu
      onFolderCreated={onFolderCreated}
      uploadOnly
      render={
        <WorkspaceGridRow
          className={cn(
            bottomRowClassName,
            isFlashing &&
              "bg-primary/10 ring-primary/60 animate-pulse ring-2 ring-inset",
          )}
          role="button"
        >
          <WorkspaceGridCell
            className="z-10 flex items-center justify-center border-t-2"
            style={{
              left: table.getColumn(selectColId)?.getStart("left"),
              right: table.getColumn(selectColId)?.getStart("right"),
              position: "sticky",
            }}
          >
            <PlusIcon className="size-4" />
          </WorkspaceGridCell>
          <WorkspaceGridCell
            className="z-10 flex items-center border-e-0 border-t-2"
            style={{
              left: table.getColumn(selectColId)?.getSize(),
              right: table.getColumn(selectColId)?.getSize(),
              position: "sticky",
            }}
          >
            {t("workspaces.newDocument")}
          </WorkspaceGridCell>
          <WorkspaceGridCell
            aria-hidden="true"
            className="border-t-2"
            role="presentation"
            style={{ gridColumn: "3 / -1" }}
          />
        </WorkspaceGridRow>
      }
      workspaceId={workspaceId}
    />
  );
};
