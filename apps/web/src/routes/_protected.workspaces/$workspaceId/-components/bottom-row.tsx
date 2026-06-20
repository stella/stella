import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import type { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
// Add-row is chrome, not data: it recedes (muted, single hairline border) and
// surfaces on hover so it doesn't compete with the rows above it.
const bottomRowClassName = `sticky bottom-0 z-20 cursor-pointer text-muted-foreground transition-colors duration-150 hover:text-foreground ${TOOLBAR_ROW_HEIGHT}`;

type BottomRowProps = {
  workspaceId: string;
  table: WorkspaceTable;
  onFolderCreated?: ((entityId: string) => void) | undefined;
};

export const BottomRow = ({
  workspaceId,
  table,
  onFolderCreated,
}: BottomRowProps) => {
  const t = useTranslations();

  return (
    <AddEntityMenu
      onFolderCreated={onFolderCreated}
      uploadOnly
      render={
        <WorkspaceGridRow className={bottomRowClassName} role="button">
          <WorkspaceGridCell
            className="z-10 flex items-center justify-center border-t"
            style={{
              left: table.getColumn(selectColId)?.getStart("left"),
              right: table.getColumn(selectColId)?.getStart("right"),
              position: "sticky",
            }}
          >
            <PlusIcon className="size-3.5" />
          </WorkspaceGridCell>
          <WorkspaceGridCell
            className="z-10 flex items-center border-e-0 border-t text-sm"
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
            className="border-t"
            role="presentation"
            style={{ gridColumn: "3 / -1" }}
          />
        </WorkspaceGridRow>
      }
      workspaceId={workspaceId}
    />
  );
};
