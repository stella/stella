type LoadWorkspaceRouteQueriesOptions<TWorkspace> = {
  loadWorkspace: () => Promise<TWorkspace>;
  startPrefetches: readonly (() => void)[];
};

// Start every independent request in the same loader turn. Awaiting the
// breadcrumb query first turns otherwise parallel matter data into a network
// waterfall on every cold navigation.
export const loadWorkspaceRouteQueries = async <TWorkspace>({
  loadWorkspace,
  startPrefetches,
}: LoadWorkspaceRouteQueriesOptions<TWorkspace>): Promise<TWorkspace> => {
  const workspace = loadWorkspace();
  for (const startPrefetch of startPrefetches) {
    startPrefetch();
  }
  return await workspace;
};
