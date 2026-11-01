type LoadWorkspaceRouteQueriesOptions<TWorkspace> = {
  loadWorkspace: () => Promise<TWorkspace>;
  shouldStartPrefetches: (workspace: TWorkspace) => boolean;
  startPrefetches: readonly (() => void)[];
};

export const loadWorkspaceRouteQueries = async <TWorkspace>({
  loadWorkspace,
  shouldStartPrefetches,
  startPrefetches,
}: LoadWorkspaceRouteQueriesOptions<TWorkspace>): Promise<TWorkspace> => {
  const workspace = await loadWorkspace();
  if (shouldStartPrefetches(workspace)) {
    for (const startPrefetch of startPrefetches) {
      startPrefetch();
    }
  }
  return workspace;
};
