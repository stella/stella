import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";

type BottomRowProps = {
  workspaceId: string;
  onFolderCreated?: ((entityId: string) => void) | undefined;
};

export const BottomRow = ({ workspaceId, onFolderCreated }: BottomRowProps) => {
  const t = useTranslations();

  return (
    <WorkspaceGridRow className="sticky bottom-0 z-10">
      <WorkspaceGridCell
        className="z-10 border-t-2 transition-colors"
        style={{ gridColumn: "1 / -1" }}
      >
        <AddEntityMenu
          onFolderCreated={onFolderCreated}
          uploadOnly
          render={
            <button
              className="flex items-center gap-2"
              title={t("workspaces.newDocument")}
            >
              <PlusIcon className="size-4" />
              {t("workspaces.newDocument")}
            </button>
          }
          workspaceId={workspaceId}
        />
      </WorkspaceGridCell>
    </WorkspaceGridRow>
  );
};
