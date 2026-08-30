import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { getInternalColId } from "@/components/workspaces/entity-utils";
import type { WorkspaceTable } from "@/components/workspaces/table/types";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";

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
        <WorkspaceGridRow
          className={cn(bottomRowClassName)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
          role="button"
          tabIndex={0}
          {...guideAnchor(GUIDE_ANCHORS.documentsUpload)}
        >
          <WorkspaceGridCell
            className="z-10 flex items-center justify-center border-t"
            style={{
              insetInlineStart: table.getColumn(selectColId)?.getStart("start"),
              position: "sticky",
            }}
          >
            <PlusIcon className="size-3.5" />
          </WorkspaceGridCell>
          <WorkspaceGridCell
            className="z-10 flex items-center border-e-0 border-t text-sm"
            style={{
              insetInlineStart: table.getColumn(selectColId)?.getSize(),
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
