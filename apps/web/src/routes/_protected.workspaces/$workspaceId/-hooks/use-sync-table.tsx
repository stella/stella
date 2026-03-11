import { useEffect } from "react";

import { useSuspenseQueries } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { justificationsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

export const useSyncTable = () => {
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (p) => p.workspaceId,
  });
  const syncJustifications = useWorkspaceStore((s) => s.syncJustifications);

  const [, justificationsQuery] = useSuspenseQueries({
    queries: [
      {
        ...propertiesOptions(workspaceId),
        refetchOnMount: true,
      },
      justificationsOptions(workspaceId),
    ],
  });

  const justifications = justificationsQuery.data;

  useEffect(() => {
    syncJustifications(justifications);
  }, [justifications, syncJustifications]);
};
