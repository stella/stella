// A suppression becoming unused proves the path-read detector stopped firing.

declare const router: {
  state: { location: { pathname: string }; matches: readonly unknown[] };
};
declare const getCurrentWorkspaceDocument: (matches: readonly unknown[]) => {
  workspaceId: string;
} | null;

export const sliced = (pathname: string, workspaceId: string) => {
  const prefix = `/workspaces/${workspaceId}/`;
  // oxlint-disable-next-line no-route-identity-from-path/no-route-identity-from-path -- The view id is sliced off the URL path.
  return pathname.slice(prefix.length).split("/").at(0);
};

export const onDocumentPage = (workspaceId: string) =>
  // oxlint-disable-next-line no-route-identity-from-path/no-route-identity-from-path -- A path regex restates the document route.
  new RegExp(`^/workspaces/${workspaceId}/[^/]+/document`, "u").test(
    router.state.location.pathname,
  );

// expect-clean: no-route-identity-from-path/no-route-identity-from-path
export const owned = (workspaceId: string) =>
  getCurrentWorkspaceDocument(router.state.matches)?.workspaceId ===
  workspaceId;
