/**
 * Detect that the user is already on the document route for this
 * entity. The route is `/workspaces/{workspaceId}/{viewId}/document`
 * where viewId is the view selector (typically "all"), and the
 * entity being viewed lives in the `entity` search param. If both
 * match, the entity is already the main view and clicking its
 * mention should surface metadata in the inspector rather than
 * opening a duplicate file lane that races the main view.
 *
 * The `location` argument defaults to `window.location` so the
 * call sites stay one-arg, but the test suite can pass a stub
 * (Bun's web test runtime has no DOM globals).
 */
type LocationLike = { pathname: string; search: string };

export const isEntityActiveInMainRoute = (
  entityId: string,
  workspaceId: string,
  location: LocationLike | null = typeof window === "undefined"
    ? null
    : window.location,
): boolean => {
  if (location === null) {
    return false;
  }
  const onDocumentRoute = new RegExp(
    `^/workspaces/${workspaceId}/[^/]+/document(?:/|$|\\?)`,
    "u",
  ).test(location.pathname);
  if (!onDocumentRoute) {
    return false;
  }
  const entityParam = new URLSearchParams(location.search).get("entity");
  return entityParam === entityId;
};
