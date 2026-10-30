import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  workspaceOptions,
  workspacesNavigationOptions,
  workspacesOptions,
} from "@/lib/workspaces/queries";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { workflowOptions } from "@/lib/workspaces/queries/workspace";

type DeleteEntityQueriesOptions = {
  collectionQueryKeys: readonly QueryKey[];
  entityQueryKeys: readonly QueryKey[];
  queryClient: QueryClient;
};

/** Remove an entity's cache before refreshing the collections that named it. */
export const deleteEntityQueries = async ({
  collectionQueryKeys,
  entityQueryKeys,
  queryClient,
}: DeleteEntityQueriesOptions): Promise<void> => {
  await Promise.all(
    entityQueryKeys.map(async (queryKey) => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
    }),
  );

  await Promise.all(
    collectionQueryKeys.map(async (queryKey) => {
      await queryClient.invalidateQueries({ exact: true, queryKey });
    }),
  );
};

type DeleteMatterQueriesOptions = {
  activeOrganizationId: string;
  queryClient: QueryClient;
  userId: string;
  workspaceId: string;
};

export const deleteMatterQueries = async ({
  activeOrganizationId,
  queryClient,
  userId,
  workspaceId,
}: DeleteMatterQueriesOptions): Promise<void> => {
  await deleteEntityQueries({
    queryClient,
    entityQueryKeys: [
      workspaceOptions(workspaceId).queryKey,
      propertiesOptions(workspaceId).queryKey,
      viewsOptions(workspaceId).queryKey,
      workflowOptions({ key: { workspaceId } }).queryKey,
    ],
    collectionQueryKeys: [
      workspacesOptions(activeOrganizationId).queryKey,
      workspacesNavigationOptions({
        organizationId: activeOrganizationId,
        userId,
      }).queryKey,
    ],
  });
};
