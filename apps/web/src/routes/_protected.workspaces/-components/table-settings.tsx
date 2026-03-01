import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { RowSelectionState } from "@tanstack/react-table";
import { Result } from "better-result";
import { FileDownIcon, SettingsIcon, TrashIcon } from "lucide-react";
import Papa from "papaparse";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stella/ui/components/alert-dialog";
import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import { toastManager } from "@stella/ui/components/toast";

import type { WorkspaceProperty } from "@/lib/types";
import { useDeleteWorkspace } from "@/routes/_protected.workspaces/-mutations";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { getFieldValue } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type ExportToCSVProps = {
  workspaceName: string;
  properties: WorkspaceProperty[];
  rowSelection: RowSelectionState;
};

const exportToCSV = ({
  workspaceName,
  properties,
  rowSelection,
}: ExportToCSVProps) => {
  const { getEntities } = useWorkspaceStore.getState();
  const entities = getEntities(rowSelection);

  if (properties.length === 0 || entities.length === 0) {
    return Result.err("no-data-to-export");
  }

  const headers = properties.map((property) => property.name);

  const rows = entities.map((entity) => {
    return properties.map((property) => {
      const field = entity.fields[property.id];

      return getFieldValue(field);
    });
  });

  const csvData = [headers, ...rows];
  const csv = Papa.unparse(csvData);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });

  downloadFile(blob, `stella-${workspaceName}.csv`);

  return Result.ok();
};

type TableSettingsProps = {
  workspaceId: string;
};

export const TableSettings = ({ workspaceId }: TableSettingsProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { data: workspace } = useSuspenseQuery(workspaceOptions(workspaceId));
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const deleteWorkspace = useDeleteWorkspace();

  const rowSelection = useSearch({
    from: "/_protected/workspaces/$workspaceId",
    select: (s) => s.rowSelection,
  });
  const isWorkflowRunning = useIsWorkflowRunning();
  const [isAlertDialogOpen, setIsAlertDialogOpen] = useState(false);
  const canExportToCSV =
    useWorkspaceStore((s) => s.data.length > 0) && properties.length > 0;

  const handleDeleteWorkspace = () => {
    if (deleteWorkspace.isPending) {
      return;
    }

    const toastId = toastManager.add({
      title: t("workspaces.deletingWorkspace"),
      type: "loading",
      timeout: Number.POSITIVE_INFINITY,
    });

    deleteWorkspace.mutate(
      { workspaceId },
      {
        onError: () => {
          toastManager.update(toastId, {
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
        onSuccess: async () => {
          toastManager.update(toastId, {
            title: t("success.workspaceDeletedSuccessfully"),
            type: "success",
          });
          await navigate({ to: "/workspaces" });
        },
      },
    );
  };

  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="sm" variant="outline" />}>
          <SettingsIcon /> {t("common.settings")}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            closeOnClick
            disabled={!canExportToCSV || isWorkflowRunning}
            onClick={() =>
              exportToCSV({
                workspaceName: workspace.name,
                properties,
                rowSelection,
              }).mapError((e) => {
                if (e === "no-data-to-export") {
                  toastManager.add({
                    title: t("errors.failedToExportNoData"),
                    type: "error",
                  });
                }
              })
            }
          >
            <FileDownIcon /> {t("workspaces.exportToCsv")}
          </MenuItem>
          <MenuItem
            closeOnClick
            disabled={deleteWorkspace.isPending || isWorkflowRunning}
            onClick={() => setIsAlertDialogOpen(true)}
            variant="destructive"
          >
            <TrashIcon />
            {t("workspaces.deleteWorkspace")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog onOpenChange={setIsAlertDialogOpen} open={isAlertDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.deleteWorkspace")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspaces.deleteWorkspaceConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={
                <Button onClick={handleDeleteWorkspace} variant="destructive" />
              }
            >
              {t("common.delete")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
