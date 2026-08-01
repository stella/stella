import type { QueryClient } from "@tanstack/react-query";

import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

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
