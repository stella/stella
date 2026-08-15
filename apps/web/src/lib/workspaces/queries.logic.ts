import type { MatterActivityFilters } from "@stll/api-contract/matter-activity";

import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";

export {
  DEFAULT_MATTER_ACTIVITY_FILTERS,
  MATTER_ACTIVITY_ACTIONS,
  MATTER_ACTIVITY_CATEGORIES,
} from "@stll/api-contract/matter-activity";
export type {
  MatterActivityAction,
  MatterActivityCategory,
  MatterActivityFilters,
} from "@stll/api-contract/matter-activity";

export type WorkspaceActivityKey = {
  workspaceId: string;
};

export const toMatterActivityQuery = (filters: MatterActivityFilters) => ({
  action: filters.action,
  category: filters.category,
  ...(filters.actorId === null ? {} : { actorId: filters.actorId }),
  ...(filters.from === null ? {} : { from: filters.from }),
  ...(filters.toExclusive === null ? {} : { toExclusive: filters.toExclusive }),
});

export const workspacesKeys = {
  all: ["workspaces"],
  list: (activeOrganizationId: string) => [
    ...workspacesKeys.all,
    "list",
    activeOrganizationId,
  ],
  navigationAll: () => [...workspacesKeys.all, "navigation"],
  navigation: (activeOrganizationId: string) => [
    ...workspacesKeys.navigationAll(),
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
    filters: MatterActivityFilters,
  ) => [
    ...workspacesKeys.overviewActivityAll(workspaceId),
    activeOrganizationId,
    {
      action: filters.action,
      actorId: filters.actorId,
      category: filters.category,
      from: filters.from,
      toExclusive: filters.toExclusive,
    },
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
