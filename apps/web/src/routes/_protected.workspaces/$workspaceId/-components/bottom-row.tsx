import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import type { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");

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
        <WorkspaceGridRow className="cursor-pointer" role="button">
          <WorkspaceGridCell
            className="z-10 flex items-center justify-center"
            style={{
              left: table.getColumn(selectColId)?.getStart("left"),
              right: table.getColumn(selectColId)?.getStart("right"),
              position: "sticky",
            }}
          >
            <PlusIcon className="size-4" />
          </WorkspaceGridCell>
          <WorkspaceGridCell
            className="z-10 flex items-center border-e-0"
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
            role="presentation"
            style={{ gridColumn: "3 / -1" }}
          />
        </WorkspaceGridRow>
      }
      workspaceId={workspaceId}
    />
  );
};
