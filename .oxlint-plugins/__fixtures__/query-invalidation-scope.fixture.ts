export const useBoundedEntityMutation = () => {
  useMutation({
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.detail(workspaceId, entityId),
      }),
  });

  useInfiniteQuery({ queryKey: ["entities"], maxPages: 3 });
};
