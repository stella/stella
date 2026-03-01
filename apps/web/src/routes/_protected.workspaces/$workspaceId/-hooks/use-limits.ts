import { useSuspenseQuery } from "@tanstack/react-query";

import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

export const usePropertiesCountLimit = (workspaceId: string) => {
  const propertiesCount = useSuspenseQuery({
    ...propertiesOptions(workspaceId),
    select: (data) => data.length,
  }).data;
  const maxPropertiesCount = useSuspenseQuery({
    ...workspaceOptions(workspaceId),
    select: (data) => data.limits.propertiesCount,
  }).data;

  return propertiesCount >= maxPropertiesCount;
};

export const useEntitiesCountLimit = (workspaceId: string) => {
  const entitiesCount = useSuspenseQuery({
    ...entitiesOptions(workspaceId),
    select: (data) => data.length,
  }).data;
  const maxEntitiesCount = useSuspenseQuery({
    ...workspaceOptions(workspaceId),
    select: (data) => data.limits.entitiesCount,
  }).data;

  return entitiesCount >= maxEntitiesCount;
};
