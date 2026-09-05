import { useMemo, useState } from "react";

import type { Hotkey } from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { ENTITIES_PER_WORKSPACE_MAX } from "@stll/api-contract";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { usePermissions } from "@/hooks/use-permissions";
import { useEffectiveShortcutGroups } from "@/lib/use-effective-shortcuts";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { useCreateTask } from "@/lib/workspaces/mutations/tasks";
import { entitySummariesCountOptions } from "@/lib/workspaces/queries/entities";
import { workflowOptions } from "@/lib/workspaces/queries/workspace";

import { COMMAND_ACTIONS } from "../lib/registry";
import type { CommandAction, CommandActionContext } from "../lib/types";

export type ResolvedCommandAction = CommandAction & {
  title: string;
  keywordLabels: readonly string[];
  hotkey?: Hotkey;
};

type UploadRequest =
  | { type: "closed" }
  | { type: "open"; workspaceId: string | undefined };

type UseCommandActionsResult = {
  uploadRequest: UploadRequest;
  closeUpload: () => void;
  resolvedActions: ResolvedCommandAction[];
  executeAction: (actionId: string) => void;
};

export function useCommandActions(open: boolean): UseCommandActionsResult {
  const t = useTranslations();
  const workspaceId = useParams({
    strict: false,
    select: (params) => params.workspaceId,
  });

  const [uploadRequest, setUploadRequest] = useState<UploadRequest>({
    type: "closed",
  });
  const { mutate: createTask, isPending: isCreatingTask } = useCreateTask();
  const canCreateEntity = usePermissions({ entity: ["create"] });
  const { data: entityCount } = useQuery({
    ...entitySummariesCountOptions(workspaceId ?? ""),
    enabled: open && workspaceId !== undefined && canCreateEntity,
  });
  const { data: workflow } = useQuery({
    ...workflowOptions({ key: { workspaceId: workspaceId ?? "" } }),
    enabled: open && workspaceId !== undefined && canCreateEntity,
  });
  const canCreateTask =
    canCreateEntity &&
    workspaceId !== undefined &&
    entityCount !== undefined &&
    entityCount < ENTITIES_PER_WORKSPACE_MAX &&
    workflow !== undefined &&
    !workflow.running &&
    !isCreatingTask;
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatterDialog = useCreateMatterStore((s) => s.openDialog);
  const openChat = useInspectorTabsStore((s) => s.openChat);
  const shortcutGroups = useEffectiveShortcutGroups();

  const context: CommandActionContext = useMemo(
    () => ({
      canCreateMatter,
      canUploadDocument: canCreateEntity,
      canCreateTask,
      openUploadDocument: () => setUploadRequest({ type: "open", workspaceId }),
      createTask: () => {
        if (workspaceId === undefined) {
          panic("Task action requires a matter");
        }
        createTask(workspaceId);
      },
      openCreateMatterDialog: () => {
        openCreateMatterDialog();
      },
      openNewChat: () => {
        openChat(
          workspaceId === undefined
            ? {}
            : { workspaceId, contextMatterIds: [workspaceId] },
        );
      },
    }),
    [
      canCreateMatter,
      canCreateEntity,
      canCreateTask,
      createTask,
      openChat,
      openCreateMatterDialog,
      workspaceId,
    ],
  );

  const effectiveHotkeys = useMemo(() => {
    const hotkeys = new Map<CommandAction["shortcutId"], Hotkey>();
    for (const group of shortcutGroups) {
      for (const shortcut of group.shortcuts) {
        if (shortcut.binding.type === "hotkey") {
          hotkeys.set(shortcut.id, shortcut.binding.hotkey);
        }
      }
    }
    return hotkeys;
  }, [shortcutGroups]);

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
          if (action.shortcutId === undefined) {
            return resolved;
          }
          resolved.shortcutId = action.shortcutId;
          const hotkey = effectiveHotkeys.get(action.shortcutId);
          if (!hotkey) {
            panic(`No effective hotkey for command action "${action.id}"`);
          }
          resolved.hotkey = hotkey;
          return resolved;
        },
      ),
    [context, effectiveHotkeys, t],
  );

  const executeAction = (actionId: string) => {
    const action = resolvedActions.find((a) => a.id === actionId);
    if (!action) {
      panic(`Unknown command action "${actionId}"`);
    }
    action.run(context);
  };

  return {
    resolvedActions,
    executeAction,
    uploadRequest,
    closeUpload: () => setUploadRequest({ type: "closed" }),
  };
}
