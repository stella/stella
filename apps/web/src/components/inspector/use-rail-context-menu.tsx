import { MessageSquarePlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { MenuItem } from "@stll/ui/components/menu";

import { useInspectorStore } from "@/components/inspector/inspector-store";
import type { ChatTab } from "@/components/inspector/inspector-store";
import { useAnchoredMenu } from "@/components/inspector/use-anchored-menu";

/**
 * Right-click menu for the inspector rail's empty space — one
 * "New chat" item, scoped to the caller's matter when present so
 * the resulting tab inherits `contextMatterIds`. With no matter
 * (pane mounted on a global route), the menu opens a global chat.
 */
export const useRailContextMenu = ({
  activeSkill,
  workspaceId,
}: {
  activeSkill?: ChatTab["activeSkill"];
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
              ? { ...(activeSkill ? { activeSkill } : {}) }
              : {
                  ...(activeSkill ? { activeSkill } : {}),
                  workspaceId,
                  contextMatterIds: [workspaceId],
                },
          )
        }
      >
        <MessageSquarePlusIcon />
        {t("chat.newChat")}
      </MenuItem>
    ),
  });
};
