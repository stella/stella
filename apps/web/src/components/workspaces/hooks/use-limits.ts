import { useQuery } from "@tanstack/react-query";

import {
  ENTITIES_PER_WORKSPACE_MAX,
  PROPERTIES_PER_WORKSPACE_MAX,
} from "@stll/api-contract";

import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";
import { entitySummariesCountOptions } from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";

// The caps are static product constants shared with the API through
// @stll/api-contract, so only the current count is fetched.
//
// These hooks are consumed inside menus and other chrome surfaces, so
// they use useQuery (not useSuspenseQuery) per AGENTS.md — a cache miss
// must not suspend the surrounding layout. While the query is loading
// we treat the limit as not-reached so the action stays available; the
// backend is the source of truth and will reject if the limit is hit.
/** `null` where the surface is not a workspace's: no id, so no read. */
export const usePropertiesCountLimit = (workspaceId: string | null) => {
  const propertiesCountQuery = useQuery({
    ...propertiesOptions(workspaceId ?? ""),
    enabled: workspaceId !== null,
    select: (data) => data.length,
  });
  const propertiesCountView = useQueryView(propertiesCountQuery);
  useQueryViewError(propertiesCountView);
  const propertiesCount =
    propertiesCountView.type === "items"
      ? propertiesCountView.items
      : undefined;

  if (workspaceId === null) {
    return false;
  }
  if (propertiesCountQuery.status === "error") {
    return true;
  }
  if (propertiesCount === undefined) {
    return false;
  }
  return propertiesCount >= PROPERTIES_PER_WORKSPACE_MAX;
};

export const useEntitiesCountLimit = (workspaceId: string) => {
  const entitiesCountQuery = useQuery({
    ...entitySummariesCountOptions(workspaceId),
  });
  const entitiesCountView = useQueryView(entitiesCountQuery);
  useQueryViewError(entitiesCountView);
  const entitiesCount =
    entitiesCountView.type === "items" ? entitiesCountView.items : undefined;

  if (entitiesCountQuery.status === "error") {
    return true;
  }
  if (entitiesCount === undefined) {
    return false;
  }
  return entitiesCount >= ENTITIES_PER_WORKSPACE_MAX;
};
