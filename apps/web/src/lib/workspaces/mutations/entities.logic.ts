import type { QueryClient } from "@tanstack/react-query";

import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import {
  entitiesKeys,
  isEntityCollectionQueryKey,
} from "@/lib/workspaces/queries/entities.logic";
import { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

type InvalidateDeletedEntityQueriesOptions = {
  queryClient: QueryClient;
  workspaceId: string;
  entityIds: readonly string[];
};

export const invalidateDeletedEntityQueries = async ({
  queryClient,
  workspaceId,
  entityIds,
}: InvalidateDeletedEntityQueriesOptions): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
      predicate: ({ queryKey }) => isEntityCollectionQueryKey(queryKey),
    }),
    ...entityIds.map(
      async (entityId) =>
        await queryClient.invalidateQueries({
          queryKey: entitiesKeys.detail(workspaceId, entityId),
        }),
    ),
    queryClient.invalidateQueries({
      queryKey: taskKeys.all(workspaceId),
    }),
    queryClient.invalidateQueries({
      queryKey: workspacesKeys.overview(workspaceId),
    }),
  ]);
};
