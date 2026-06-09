import type { ComponentProps } from "react";

import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

type FolderExpandToggleProps = {
  allExpanded: boolean;
  onToggle: () => void;
  size?: ComponentProps<typeof Button>["size"];
};

/**
 * Expand/collapse-all-folders toggle, shared by the workspace Files view and the
 * skills file tree so both expose the same affordance from one place. The icon
 * reflects the current state: an open folder when everything is expanded (click
 * to collapse), a closed folder otherwise (click to expand).
 */
export const FolderExpandToggle = ({
  allExpanded,
  onToggle,
  size = "icon-xs",
}: FolderExpandToggleProps) => {
  const t = useTranslations();
  return (
    <Button
      onClick={onToggle}
      size={size}
      title={
        allExpanded
          ? t("workspaces.filesystem.collapseAll")
          : t("workspaces.filesystem.expandAll")
      }
      variant="ghost"
    >
      {allExpanded ? (
        <FolderOpenIcon className="size-3.5" />
      ) : (
        <FolderIcon className="size-3.5" />
      )}
    </Button>
  );
};
