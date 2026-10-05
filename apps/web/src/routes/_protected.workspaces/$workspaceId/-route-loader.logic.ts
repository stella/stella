type LoadWorkspaceRouteQueriesOptions<TWorkspace> = {
  loadWorkspace: () => Promise<TWorkspace>;
  loadFirstRenderQueries: readonly (() => Promise<unknown>)[];
  startPrefetches: readonly (() => void)[];
};

// Start every independent request in the same loader turn. Awaiting the
// breadcrumb query first turns otherwise parallel matter data into a network
// waterfall on every cold navigation.
export const loadWorkspaceRouteQueries = async <TWorkspace>({
  loadWorkspace,
  loadFirstRenderQueries,
  startPrefetches,
}: LoadWorkspaceRouteQueriesOptions<TWorkspace>): Promise<TWorkspace> => {
  const workspace = loadWorkspace();
  const firstRenderQueries = Promise.all(
    loadFirstRenderQueries.map((loadQuery) => loadQuery()),
  );
  for (const startPrefetch of startPrefetches) {
    startPrefetch();
  }
  const [loadedWorkspace] = await Promise.all([workspace, firstRenderQueries]);
  return loadedWorkspace;
};
