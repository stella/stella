import {
  entitiesKeys,
  isEntityCollectionQueryKey,
} from "../../apps/web/src/lib/workspaces/queries/entities.logic";

export const useBoundedEntityMutation = () => {
  useMutation({
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.detail(workspaceId, entityId),
      }),
  });
};

export const invalidateEveryEntityQuery = () =>
  // oxlint-disable-next-line query-invalidation-scope/query-invalidation-scope
  queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId) });

export const invalidateEntityCollections = () =>
  // expect-clean: query-invalidation-scope/query-invalidation-scope
  queryClient.invalidateQueries({
    queryKey: entitiesKeys.all(workspaceId),
    predicate: ({ queryKey }) => isEntityCollectionQueryKey(queryKey),
  });
