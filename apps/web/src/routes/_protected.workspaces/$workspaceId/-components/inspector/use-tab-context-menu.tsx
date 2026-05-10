import {
  ListXIcon,
  Maximize2Icon,
  PanelRightIcon,
  PenLineIcon,
  XIcon,
  XSquareIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { MenuItem, MenuSeparator } from "@stll/ui/components/menu";

import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useAnchoredMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-anchored-menu";

/**
 * Per-tab context menu shared by two surfaces — right-click on
 * the rail icon AND right-click on the visible label inside the
 * ribbon — so the same actions live in one place.
 *
 * `onMaximize` is optional: tab kinds with a main-view counterpart
 * (e.g. a chat tab → `/chat/...`) supply it and the menu surfaces
 * a "Move to main view" item; tabs without one (today: tasks) omit
 * it. The leading "Hide pane" mirrors the rail's top button so the
 * gesture is reachable from either entry point.
 */
export const useTabContextMenu = ({
  tabId,
  onClose,
  onMaximize,
}: {
  tabId: string;
  onClose: () => void;
  onMaximize?: (() => void) | undefined;
}) => {
  const t = useTranslations();
  const closeOthers = useInspectorStore((s) => s.closeOthers);
  const closeAll = useInspectorStore((s) => s.closeAll);
  const requestRename = useInspectorStore((s) => s.requestRename);
  const setMinimized = useInspectorStore((s) => s.setMinimized);
  const tabsCount = useInspectorStore((s) => s.tabs.length);
  const hasOthers = tabsCount > 1;

  return useAnchoredMenu({
    children: (
      <>
        <MenuItem onClick={() => setMinimized(true)}>
          <PanelRightIcon />
          {t("inspector.hidePane")}
        </MenuItem>
        {onMaximize && (
          <MenuItem onClick={onMaximize}>
            <Maximize2Icon />
            {t("chat.moveToMain")}
          </MenuItem>
        )}
        <MenuSeparator />
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
