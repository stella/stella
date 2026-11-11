import { useTranslations } from "use-intl";

import { FolderInputIcon } from "@stll/ui/icons";
import { MenuItem } from "@stll/ui/menu";

import { usePermissions } from "@/hooks/use-permissions";

import { SHAREPOINT_ACCESS } from "./sharepoint-access.logic";
import { useSharepointAccess } from "./sharepoint-hooks";

/**
 * "From SharePoint" in a matter's add menu. The gate is read when the menu
 * opens, so a deployment without SharePoint never asks for it on page load;
 * the entry appears only once the organization's opt-in is confirmed.
 */
export const SharepointImportMenuItem = ({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: () => void;
}) => {
  const t = useTranslations();
  const access = useSharepointAccess();
  const canCreate = usePermissions({ entity: ["create"] });
  if (
    !canCreate ||
    access.type !== "items" ||
    access.items.type !== SHAREPOINT_ACCESS.enabled
  ) {
    return null;
  }
  return (
    <MenuItem disabled={disabled} onClick={onSelect}>
      <FolderInputIcon />
      {t("sharepoint.picker.menuItem")}
    </MenuItem>
  );
};
