type LoadWorkspaceRouteQueriesOptions<TWorkspace> = {
  loadWorkspace: () => Promise<TWorkspace>;
  /** Whether the matter, as loaded, is one the active-only queries serve. */
  isActive: (workspace: TWorkspace) => boolean;
  /**
   * The client already holds the matter in a status other than active, so
   * the active-only queries wait for the loaded matter to confirm it.
   */
  knownInactive: boolean;
  startPrefetches: readonly (() => void)[];
};

const startAll = (startPrefetches: readonly (() => void)[]) => {
  for (const startPrefetch of startPrefetches) {
    startPrefetch();
  }
};

// Start every independent request in the same loader turn. Awaiting the
// breadcrumb query first turns otherwise parallel matter data into a network
// waterfall on every cold navigation. Only a matter the client already knows
// is not active waits, so an archived matter never asks for active-only data.
export const loadWorkspaceRouteQueries = async <TWorkspace>({
  loadWorkspace,
  isActive,
  knownInactive,
  startPrefetches,
}: LoadWorkspaceRouteQueriesOptions<TWorkspace>): Promise<TWorkspace> => {
  if (knownInactive) {
    const workspace = await loadWorkspace();
    if (isActive(workspace)) {
      startAll(startPrefetches);
    }
    return workspace;
  }
  const workspace = loadWorkspace();
  startAll(startPrefetches);
  return await workspace;
};
