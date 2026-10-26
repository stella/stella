// A suppression becoming unused proves the path-segment detector stopped firing.

declare const router: { state: { location: { pathname: string } } };
declare const getCurrentWorkspaceView: (reader: typeof router) => unknown;

export const sliced = (pathname: string, workspaceId: string) => {
  const prefix = `/workspaces/${workspaceId}/`;
  // oxlint-disable-next-line no-view-id-from-path/no-view-id-from-path -- The view id is sliced off the URL path.
  return pathname.slice(prefix.length).split("/").at(0);
};

export const matched = () =>
  // oxlint-disable-next-line no-view-id-from-path/no-view-id-from-path -- A regex reads the view segment off the router's path.
  /^\/workspaces\/[^/]+\/([^/]+)/u.exec(router.state.location.pathname)?.[1];

// expect-clean: no-view-id-from-path/no-view-id-from-path
export const owned = (workspaceId: string) => ({
  current: getCurrentWorkspaceView(router),
  onDocument: new RegExp(`^/workspaces/${workspaceId}/[^/]+/document`, "u").test(
    router.state.location.pathname,
  ),
});
