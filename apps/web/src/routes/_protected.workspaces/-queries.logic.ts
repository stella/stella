import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";

export type WorkspaceActivityKey = {
  workspaceId: string;
};

export const workspacesKeys = {
  all: ["workspaces"],
  list: (activeOrganizationId: string) => [
    ...workspacesKeys.all,
    "list",
    activeOrganizationId,
  ],
  navigation: (activeOrganizationId: string) => [
    ...workspacesKeys.all,
    "navigation",
    activeOrganizationId,
  ],
  byId: (workspaceId: string) => [...workspacesKeys.all, workspaceId],
  overview: (workspaceId: string) => [
    ...workspacesKeys.byId(workspaceId),
    "overview",
  ],
  activityAll: (workspaceId: string) => [
    ...entitiesKeys.all(workspaceId),
    "activity",
  ],
  activity: (activeOrganizationId: string, key: WorkspaceActivityKey) => [
    ...workspacesKeys.activityAll(key.workspaceId),
    activeOrganizationId,
  ],
};
