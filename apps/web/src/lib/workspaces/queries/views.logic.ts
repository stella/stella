const VIEWS_QUERY_ROOT = "views";

export const viewsRootKey = (workspaceId: string) => [
  VIEWS_QUERY_ROOT,
  workspaceId,
];

/** The matter whose views list `queryKey` holds, or `null` for any other key. */
export const viewsQueryWorkspaceId = (queryKey: unknown): string | null => {
  if (!Array.isArray(queryKey)) {
    return null;
  }
  const root: unknown = queryKey.at(0);
  const workspaceId: unknown = queryKey.at(1);
  return root === VIEWS_QUERY_ROOT && typeof workspaceId === "string"
    ? workspaceId
    : null;
};
