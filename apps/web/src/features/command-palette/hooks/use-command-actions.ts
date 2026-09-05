import { useMemo } from "react";

import { useNavigate, useParams } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { useSidebar } from "@stll/ui/sidebar";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";

import { COMMAND_ACTIONS } from "../lib/registry";
import type { CommandAction, CommandActionContext } from "../lib/types";

export type ResolvedCommandAction = CommandAction & {
  title: string;
  keywordLabels: readonly string[];
};

type UseCommandActionsResult = {
  resolvedActions: ResolvedCommandAction[];
  executeAction: (actionId: string) => void;
};

export function useCommandActions(): UseCommandActionsResult {
  const t = useTranslations();
  const navigate = useNavigate();
  const workspaceId = useParams({
    strict: false,
    select: (params) => params.workspaceId,
  });

  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatterDialog = useCreateMatterStore((s) => s.openDialog);
  const openChat = useInspectorTabsStore((s) => s.openChat);
  const { toggleSidebar } = useSidebar();

  const context: CommandActionContext = useMemo(
    () => ({
      navigate: (opts) => {
        detached(navigate(opts), "command-action.navigate");
      },
      workspaceId,
      canCreateMatter,
      openCreateMatterDialog: () => {
        openCreateMatterDialog();
      },
      // Mirrors the workspace route's Mod+Shift+J handler: always spawn a
      // fresh chat tab scoped to the current matter.
      openNewChat: () => {
        if (!workspaceId) {
          return;
        }
        openChat({ workspaceId, contextMatterIds: [workspaceId] });
      },
      // Mirrors _protected.tsx's Mod+J handler: restore/minimise existing
      // tabs, otherwise open a fresh chat when a matter is active.
      toggleChat: () => {
        const store = useInspectorTabsStore.getState();
        if (store.tabs.length > 0) {
          store.toggleMinimized();
          return;
        }
        if (workspaceId) {
          store.openChat({ workspaceId, contextMatterIds: [workspaceId] });
        }
      },
      toggleSidebar,
    }),
    [
      canCreateMatter,
      navigate,
      openChat,
      openCreateMatterDialog,
      toggleSidebar,
      workspaceId,
    ],
  );

  const resolvedActions = useMemo(
    () =>
      COMMAND_ACTIONS.filter((action) => action.isAvailable(context)).map(
        (action) => {
          const resolved: ResolvedCommandAction = {
            id: action.id,
            group: action.group,
            titleKey: action.titleKey,
            icon: action.icon,
            isAvailable: action.isAvailable,
            run: action.run,
            title: t(action.titleKey),
            keywordLabels: action.keywords
              ? action.keywords.map((keyword) => t(keyword))
              : [],
          };
          if (action.keywords) {
            resolved.keywords = action.keywords;
          }
          if (action.hotkey) {
            resolved.hotkey = action.hotkey;
          }
          return resolved;
        },
      ),
    [context, t],
  );

  const executeAction = (actionId: string) => {
    const action = resolvedActions.find((a) => a.id === actionId);
    if (action) {
      action.run(context);
    }
  };

  return { resolvedActions, executeAction };
}
