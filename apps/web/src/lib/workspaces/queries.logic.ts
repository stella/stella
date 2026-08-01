import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";

export type WorkspaceActivityKey = {
  workspaceId: string;
};

export const MATTER_ACTIVITY_CATEGORIES = [
  "all",
  "documents",
  "tasks",
  "matter",
  "team",
  "court",
  "automation",
] as const;

export type MatterActivityCategory =
  (typeof MATTER_ACTIVITY_CATEGORIES)[number];

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
  overviewActivityAll: (workspaceId: string) => [
    ...workspacesKeys.overview(workspaceId),
    "activity",
  ],
  overviewActivity: (
    activeOrganizationId: string,
    workspaceId: string,
    category: MatterActivityCategory,
  ) => [
    ...workspacesKeys.overviewActivityAll(workspaceId),
    activeOrganizationId,
    category,
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
