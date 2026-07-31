import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import { useEntitiesOptions } from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import {
  chunkJustificationEntityIds,
  useSyncJustificationChunks,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";

type UseSyncTableProps = Parameters<typeof useEntitiesOptions>[0] & {
  syncJustifications?: boolean;
};

export const useSyncTable = (activeView: UseSyncTableProps) => {
  const { syncJustifications = true, workspaceId } = activeView;

  const { data: entityIds } = useSuspenseQuery({
    ...useEntitiesOptions(activeView),
    select: (data) => data.entities.map((entity) => entity.entityId),
  });

  // propertiesOptions sets refetchOnMount: false and the query
  // has a 5-minute staleTime. Real-time invalidation is handled
  // by the workflow actor events in $viewId.route.tsx, so we
  // just subscribe to the cached query here.
  useQuery(propertiesOptions(workspaceId));

  const justificationEntityIdChunks = chunkJustificationEntityIds(entityIds);
  useSyncJustificationChunks(
    { workspaceId, entityIdChunks: justificationEntityIdChunks },
    { enabled: syncJustifications },
  );
};
