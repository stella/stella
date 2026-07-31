import type { QueryClient } from "@tanstack/react-query";

import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";
import { invalidateWorkspaceActivity } from "@/routes/_protected.workspaces/-queries";

type InvalidateCreatedDocumentQueriesOptions = {
  matterId: string;
  queryClient: QueryClient;
};

export const invalidateCreatedDocumentQueries = async ({
  matterId,
  queryClient,
}: InvalidateCreatedDocumentQueriesOptions): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: entitiesKeys.all(matterId) }),
    invalidateWorkspaceActivity(queryClient, matterId),
  ]);
};
