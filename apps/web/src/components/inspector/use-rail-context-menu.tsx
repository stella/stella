import { useTranslations } from "use-intl";

import { NewChatIcon } from "@stll/ui/icons";
import { MenuItem } from "@stll/ui/menu";

import { startNewInspectorChat } from "@/components/inspector/inspector-new-chat";
import type { ChatTab } from "@/components/inspector/inspector-tabs-store";
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

  return useAnchoredMenu({
    children: (
      <MenuItem
        onClick={() =>
          startNewInspectorChat(
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
        <NewChatIcon />
        {t("chat.newChat")}
      </MenuItem>
    ),
  });
};
