import { MenuItem } from "@stll/ui/components/menu";
import { MessageSquarePlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useAnchoredMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-anchored-menu";

/**
 * Right-click menu for the inspector rail's empty space — one
 * "New chat" item, scoped to the caller's matter so the resulting
 * tab inherits the right `contextMatterIds`.
 */
export const useRailContextMenu = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useTranslations();
  const openChat = useInspectorStore((s) => s.openChat);

  return useAnchoredMenu({
    children: (
      <MenuItem onClick={() => openChat({ contextMatterIds: [workspaceId] })}>
        <MessageSquarePlusIcon />
        {t("chat.newChat")}
      </MenuItem>
    ),
  });
};
