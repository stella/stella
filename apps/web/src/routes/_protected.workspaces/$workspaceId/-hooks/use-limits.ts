import { useQuery } from "@tanstack/react-query";

import { entitySummariesCountOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

// These hooks are consumed inside menus and other chrome surfaces, so
// they use useQuery (not useSuspenseQuery) per CLAUDE.md — a cache miss
// must not suspend the surrounding layout. While the queries are loading
// we treat the limit as not-reached so the action stays available; the
// backend is the source of truth and will reject if the limit is hit.
export const usePropertiesCountLimit = (workspaceId: string) => {
  const { data: propertiesCount } = useQuery({
    ...propertiesOptions(workspaceId),
    select: (data) => data.length,
  });
  const { data: maxPropertiesCount } = useQuery({
    ...workspaceOptions(workspaceId),
    select: (data) => data.limits.propertiesCount,
  });

  if (propertiesCount === undefined || maxPropertiesCount === undefined) {
    return false;
  }
  return propertiesCount >= maxPropertiesCount;
};

export const useEntitiesCountLimit = (workspaceId: string) => {
  const { data: entitiesCount } = useQuery({
    ...entitySummariesCountOptions(workspaceId),
  });
  const { data: maxEntitiesCount } = useQuery({
    ...workspaceOptions(workspaceId),
    select: (data) => data.limits.entitiesCount,
  });

  if (entitiesCount === undefined || maxEntitiesCount === undefined) {
    return false;
  }
  return entitiesCount >= maxEntitiesCount;
};
