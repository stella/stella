import { useQuery } from "@tanstack/react-query";

import {
  ENTITIES_PER_WORKSPACE_MAX,
  PROPERTIES_PER_WORKSPACE_MAX,
} from "@stll/api-contract";

import { entitySummariesCountOptions } from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";

// The caps are static product constants shared with the API through
// @stll/api-contract, so only the current count is fetched.
//
// These hooks are consumed inside menus and other chrome surfaces, so
// they use useQuery (not useSuspenseQuery) per CLAUDE.md — a cache miss
// must not suspend the surrounding layout. While the query is loading
// we treat the limit as not-reached so the action stays available; the
// backend is the source of truth and will reject if the limit is hit.
export const usePropertiesCountLimit = (workspaceId: string) => {
  const { data: propertiesCount } = useQuery({
    ...propertiesOptions(workspaceId),
    select: (data) => data.length,
  });

  if (propertiesCount === undefined) {
    return false;
  }
  return propertiesCount >= PROPERTIES_PER_WORKSPACE_MAX;
};

export const useEntitiesCountLimit = (workspaceId: string) => {
  const { data: entitiesCount } = useQuery({
    ...entitySummariesCountOptions(workspaceId),
  });

  if (entitiesCount === undefined) {
    return false;
  }
  return entitiesCount >= ENTITIES_PER_WORKSPACE_MAX;
};
