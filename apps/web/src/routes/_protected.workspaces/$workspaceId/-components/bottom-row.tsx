import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import { TableCell, TableRow } from "@/components/table";
import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import type { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");

type BottomRowProps = {
  workspaceId: string;
  table: WorkspaceTable;
  onFolderCreated?: (entityId: string) => void;
};

export const BottomRow = ({
  workspaceId,
  table,
  onFolderCreated,
}: BottomRowProps) => {
  const t = useTranslations();

  return (
    <TableRow className="sticky bottom-0 z-10 [&_td]:sticky [&_td]:border-t">
      <TableCell
        className="relative z-10 p-0"
        style={{
          left: table.getColumn(selectColId)?.getStart("left"),
        }}
      >
        <AddEntityMenu
          onFolderCreated={onFolderCreated}
          render={
            <Button
              className="absolute inset-0 z-10 flex size-auto! rounded-none border-r hover:bg-accent"
              size="icon"
              type="button"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          }
          workspaceId={workspaceId}
        />
      </TableCell>
      <TableCell
        className="relative z-10 border-r-0"
        style={{
          left: table.getColumn(selectColId)?.getSize(),
        }}
      >
        {t("common.newRow")}
      </TableCell>
      <TableCell colSpan={table.getAllColumns().length - 2} />
    </TableRow>
  );
};
