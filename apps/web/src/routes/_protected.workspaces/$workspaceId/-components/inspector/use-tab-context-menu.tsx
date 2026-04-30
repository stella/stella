import { MenuItem } from "@stll/ui/components/menu";
import { ListXIcon, PenLineIcon, XIcon, XSquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useAnchoredMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-anchored-menu";

/**
 * Per-tab context menu shared by two surfaces — right-click on
 * the rail icon AND right-click on the visible label inside the
 * ribbon — so the same actions live in one place.
 */
export const useTabContextMenu = ({
  tabId,
  onClose,
}: {
  tabId: string;
  onClose: () => void;
}) => {
  const t = useTranslations();
  const closeOthers = useInspectorStore((s) => s.closeOthers);
  const closeAll = useInspectorStore((s) => s.closeAll);
  const requestRename = useInspectorStore((s) => s.requestRename);
  const tabsCount = useInspectorStore((s) => s.tabs.length);
  const hasOthers = tabsCount > 1;

  return useAnchoredMenu({
    children: (
      <>
        <MenuItem onClick={() => requestRename(tabId)}>
          <PenLineIcon />
          {t("common.rename")}
        </MenuItem>
        <MenuItem onClick={onClose}>
          <XIcon />
          {t("common.close")}
        </MenuItem>
        {hasOthers && (
          <MenuItem onClick={() => closeOthers(tabId)}>
            <ListXIcon />
            {t("common.closeOthers")}
          </MenuItem>
        )}
        {hasOthers && (
          <MenuItem onClick={closeAll}>
            <XSquareIcon />
            {t("common.closeAll")}
          </MenuItem>
        )}
      </>
    ),
  });
};
