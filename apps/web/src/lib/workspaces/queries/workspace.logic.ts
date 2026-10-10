import { panic } from "better-result";

import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import type { useIsWorkflowRunning } from "@/lib/workspaces/queries/workspace";

export const workspaceWorkflowQueryRoot = (workspaceId: string) =>
  [...workspacesKeys.byId(workspaceId), "workflow"] as const;

export const workspaceJustificationsQueryRoot = (workspaceId: string) =>
  [...workspacesKeys.byId(workspaceId), "justifications"] as const;

export const workflowActionsDisabled = (
  view: ReturnType<typeof useIsWorkflowRunning>,
): boolean => {
  switch (view.type) {
    case "pending":
    case "error":
    case "empty":
      return true;
    case "items":
      return view.refetchError !== undefined || view.items;
    default:
      view satisfies never;
      return panic("Unhandled workflow query state");
  }
};
