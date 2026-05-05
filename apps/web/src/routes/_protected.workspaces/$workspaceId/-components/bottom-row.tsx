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
const bottomRowClassName = `sticky bottom-0 z-20 cursor-pointer ${TOOLBAR_ROW_HEIGHT}`;

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
        // oxlint-disable-next-line jsx_a11y/prefer-tag-over-role
        <WorkspaceGridRow className={bottomRowClassName} role="button">
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
