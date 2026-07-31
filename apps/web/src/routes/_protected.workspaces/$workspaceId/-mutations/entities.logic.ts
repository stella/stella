import type { QueryClient } from "@tanstack/react-query";

import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";
import { taskKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/tasks.logic";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries.logic";

export const invalidateDeletedEntityQueries = async ({
  queryClient,
  workspaceId,
}: {
  queryClient: QueryClient;
  workspaceId: string;
}): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    }),
    queryClient.invalidateQueries({
      queryKey: taskKeys.all(workspaceId),
    }),
    queryClient.invalidateQueries({
      queryKey: workspacesKeys.overview(workspaceId),
    }),
  ]);
};
