export const useBoundedEntityMutation = () => {
  useMutation({
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.detail(workspaceId, entityId),
      }),
  });

  useInfiniteQuery({ queryKey: ["entities"], maxPages: 3 });
};

export const invalidateEveryEntityQuery = () =>
  // oxlint-disable-next-line query-invalidation-scope/query-invalidation-scope
  queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId) });

export const useUnboundedEntities = () =>
  // oxlint-disable-next-line query-invalidation-scope/query-invalidation-scope
  useInfiniteQuery({ queryKey: ["entities"] });

// expect-clean: query-invalidation-scope/query-invalidation-scope
export const useBoundedEntities = () =>
  useInfiniteQuery({ queryKey: ["entities"], maxPages: 3 });
