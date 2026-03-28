import { useEffect, useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { justificationsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const normalizeEntityIds = (entityIds: string[]) =>
  [...new Set(entityIds)].toSorted();

export const useSyncJustifications = (entityIds: string[]) => {
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (params) => params.workspaceId,
  });
  const syncJustifications = useWorkspaceStore(
    (state) => state.syncJustifications,
  );
  const normalizedEntityIds = useMemo(
    () => normalizeEntityIds(entityIds),
    [entityIds],
  );

  const { data } = useQuery({
    ...justificationsOptions({
      workspaceId,
      entityIds: normalizedEntityIds,
    }),
    enabled: normalizedEntityIds.length > 0,
  });

  useEffect(() => {
    if (!data) {
      return;
    }

    syncJustifications(data);
  }, [data, syncJustifications]);
};
