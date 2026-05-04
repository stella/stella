import { Button } from "@stll/ui/components/button";
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
const addPropertyColId = getInternalColId("add-property");

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
  const addPropertyColumn = table.getColumn(addPropertyColId);

  return (
    <WorkspaceGridRow className="bg-muted/40 hover:bg-muted sticky bottom-0 z-10 transition-colors">
      <WorkspaceGridCell
        className="relative z-10 min-w-12 shrink-0 border-e-0 border-t-2 p-0"
        style={{
          left: table.getColumn(selectColId)?.getStart("left"),
          position: "sticky",
        }}
      >
        <AddEntityMenu
          onFolderCreated={onFolderCreated}
          uploadOnly
          render={
            <Button
              className="absolute inset-0 z-10 flex size-auto! min-w-12 shrink-0 rounded-none bg-transparent"
              size="icon"
              type="button"
              variant="ghost"
            >
              <PlusIcon className="size-4" />
            </Button>
          }
          workspaceId={workspaceId}
        />
      </WorkspaceGridCell>
      <WorkspaceGridCell
        className="text-muted-foreground relative z-10 border-e-0 border-t-2"
        style={{
          left: table.getColumn(selectColId)?.getSize(),
          position: "sticky",
        }}
      >
        <AddEntityMenu
          onFolderCreated={onFolderCreated}
          uploadOnly
          render={
            <button
              className="absolute inset-0 cursor-pointer text-start"
              type="button"
            />
          }
          workspaceId={workspaceId}
        />
        {t("workspaces.newDocument")}
      </WorkspaceGridCell>
      <WorkspaceGridCell
        className="relative border-e-0 border-t-2 p-0"
        style={{ gridColumn: addPropertyColumn ? "3 / -2" : "3 / -1" }}
      >
        <AddEntityMenu
          onFolderCreated={onFolderCreated}
          uploadOnly
          render={
            <button className="absolute inset-0 cursor-pointer" type="button" />
          }
          workspaceId={workspaceId}
        />
      </WorkspaceGridCell>
      {addPropertyColumn && (
        <WorkspaceGridCell
          aria-hidden="true"
          className="bg-muted/40 sticky end-0 z-10 border-s border-t-2 p-0"
          role="presentation"
          style={{ gridColumn: "-2 / -1" }}
        />
      )}
    </WorkspaceGridRow>
  );
};
