import { Button } from "@stll/ui/components/button";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { TableCell, TableRow } from "@/components/table";
import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import type { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
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
    <TableRow className="bg-muted/40 hover:bg-muted sticky bottom-0 z-10 transition-colors [&_td]:sticky [&_td]:border-e-0 [&_td]:border-t-2">
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
              className="absolute inset-0 z-10 flex size-auto! rounded-none bg-transparent"
              size="icon"
              type="button"
              variant="ghost"
            >
              <PlusIcon className="size-4" />
            </Button>
          }
          workspaceId={workspaceId}
        />
      </TableCell>
      <TableCell
        className="text-muted-foreground relative z-10"
        style={{
          left: table.getColumn(selectColId)?.getSize(),
        }}
      >
        <AddEntityMenu
          onFolderCreated={onFolderCreated}
          render={
            <button
              className="absolute inset-0 cursor-pointer text-start"
              type="button"
            />
          }
          workspaceId={workspaceId}
        />
        {t("workspaces.newDocument")}
      </TableCell>
      <TableCell
        className="relative p-0"
        colSpan={table.getAllColumns().length - 2}
      >
        <AddEntityMenu
          onFolderCreated={onFolderCreated}
          render={
            <button className="absolute inset-0 cursor-pointer" type="button" />
          }
          workspaceId={workspaceId}
        />
      </TableCell>
    </TableRow>
  );
};
