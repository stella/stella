import { MessageSquarePlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { MenuItem } from "@stll/ui/components/menu";

import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useAnchoredMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-anchored-menu";

/**
 * Right-click menu for the inspector rail's empty space — one
 * "New chat" item, scoped to the caller's matter when present so
 * the resulting tab inherits `contextMatterIds`. With no matter
 * (pane mounted on a global route), the menu opens a global chat.
 */
export const useRailContextMenu = ({
  workspaceId,
}: {
  workspaceId?: string | undefined;
}) => {
  const t = useTranslations();
  const openChat = useInspectorStore((s) => s.openChat);

  return useAnchoredMenu({
    children: (
      <MenuItem
        onClick={() =>
          openChat(
            workspaceId === undefined
              ? {}
              : { workspaceId, contextMatterIds: [workspaceId] },
          )
        }
      >
        <MessageSquarePlusIcon />
        {t("chat.newChat")}
      </MenuItem>
    ),
  });
};
