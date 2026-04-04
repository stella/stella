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

  // propertiesOptions sets refetchOnMount: false and the query
  // has a 5-minute staleTime. Real-time invalidation is handled
  // by the workflow actor events in $viewId.route.tsx, so we
  // just subscribe to the cached query here.
  useQuery(propertiesOptions(workspaceId));

  useSyncJustifications(entityIds);
};
