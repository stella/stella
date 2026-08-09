import { workspacesKeys } from "@/lib/workspaces/queries.logic";

export const workspaceWorkflowQueryRoot = (workspaceId: string) =>
  [...workspacesKeys.byId(workspaceId), "workflow"] as const;

export const workspaceJustificationsQueryRoot = (workspaceId: string) =>
  [...workspacesKeys.byId(workspaceId), "justifications"] as const;
