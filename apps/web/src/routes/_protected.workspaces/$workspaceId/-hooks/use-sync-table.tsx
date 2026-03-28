import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import { useSyncJustifications } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { useEntitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type UseSyncTableProps = Parameters<typeof useEntitiesOptions>[0];

export const useSyncTable = (activeView: UseSyncTableProps) => {
  const { workspaceId } = activeView;

  const { data: entityIds } = useSuspenseQuery({
    ...useEntitiesOptions(activeView),
    select: (data) => data.entities.map((entity) => entity.entityId),
  });

  useQuery({
    ...propertiesOptions(workspaceId),
    refetchOnMount: true,
  });

  useSyncJustifications(entityIds);
};
